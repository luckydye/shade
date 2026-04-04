import { db, initSchema } from "./db";

export const WAITLIST_OPT_IN_LABEL =
    "Ich möchte per E-Mail über den Produktstart informiert werden.";

type WaitlistConfirmationResult = "confirmed" | "already-confirmed" | "invalid";
type WaitlistUnsubscribeResult = "unsubscribed" | "already-unsubscribed" | "invalid";
type WaitlistRequestMeta = {
    clientIp: string;
};

function invariant(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function getRequiredEnv(name: string, value: string | undefined): string {
    invariant(value && value.trim().length > 0, `${name} is required`);
    return value.trim();
}

function normalizeEmail(email: string): string {
    const normalized = email.trim().toLowerCase();
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    invariant(emailPattern.test(normalized), "Invalid email address");
    return normalized;
}

function createOpaqueToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sendWaitlistConfirmationEmail(options: {
    email: string;
    confirmationToken: string;
    unsubscribeToken: string;
    requestMeta: WaitlistRequestMeta;
}): Promise<void> {
    const resendApiKey = getRequiredEnv("RESEND_API_KEY", import.meta.env.RESEND_API_KEY);
    const resendFromEmail = getRequiredEnv("RESEND_FROM_EMAIL", import.meta.env.RESEND_FROM_EMAIL);
    const siteUrl = getRequiredEnv("import.meta.env.SITE", import.meta.env.SITE);
    const confirmationUrl = new URL(
        `/api/waitlist/confirm?token=${options.confirmationToken}`,
        siteUrl,
    ).toString();
    const unsubscribeUrl = new URL(
        `/api/waitlist/unsubscribe?token=${options.unsubscribeToken}`,
        siteUrl,
    ).toString();
    const impressumUrl = new URL("/datenschutz", siteUrl).toString();
    const subject = "Bitte bestätige deine Shade-Warteliste-Anmeldung";

    const html = `
        <div style="font-family: Inter, system-ui, sans-serif; background:#050505; color:#f5f5f4; padding:24px;">
            <div style="max-width:560px; margin:0 auto; background:#0c0c0c; border:1px solid rgba(255,255,255,0.08); border-radius:20px; padding:32px;">
                <p style="margin:0 0 12px; font-size:12px; letter-spacing:0.18em; text-transform:uppercase; color:rgba(255,255,255,0.5);">
                    Shade Waitlist
                </p>
                <h1 style="margin:0 0 16px; font-size:32px; line-height:1; text-transform:uppercase;">
                    Bitte bestätige deine Anmeldung
                </h1>
                <p style="margin:0 0 20px; font-size:16px; line-height:1.6; color:rgba(255,255,255,0.8);">
                    Du hast dich für Updates zum Produktstart von Shade eingetragen.
                    Bitte bestätige jetzt per Double Opt-In deine Anmeldung.
                </p>
                <p style="margin:0 0 28px;">
                    <a href="${confirmationUrl}" style="display:inline-block; background:#f5f5f4; color:#050505; padding:14px 22px; border-radius:999px; text-decoration:none; font-weight:600;">
                        Anmeldung bestätigen
                    </a>
                </p>
                <p style="margin:0 0 10px; font-size:14px; line-height:1.6; color:rgba(255,255,255,0.58);">
                    Falls du dich nicht angemeldet hast, kannst du diese Mail ignorieren oder dich direkt wieder austragen:
                    <a href="${unsubscribeUrl}" style="color:#f5f5f4;">Abmelden</a>
                </p>
                <p style="margin:0; font-size:14px; line-height:1.6; color:rgba(255,255,255,0.58);">
                    Impressum:
                    <a href="${impressumUrl}" style="color:#f5f5f4;">${impressumUrl}</a>
                </p>
            </div>
        </div>
    `.trim();

    const text = [
        "Shade Waitlist",
        "",
        "Bitte bestaetige deine Anmeldung.",
        "",
        `Double Opt-In bestaetigen: ${confirmationUrl}`,
        `Abmelden: ${unsubscribeUrl}`,
        `Impressum: ${impressumUrl}`,
    ].join("\n");

    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            from: resendFromEmail,
            to: [options.email],
            subject,
            html,
            text,
        }),
    });

    if (!response.ok) {
        throw new Error(`Resend email request failed: ${response.status} ${await response.text()}`);
    }
}

export async function submitWaitlistSignup(email: string, requestMeta: WaitlistRequestMeta): Promise<void> {
    await initSchema();

    const normalizedEmail = normalizeEmail(email);
    const now = new Date().toISOString();
    const confirmationToken = createOpaqueToken();
    const unsubscribeToken = createOpaqueToken();
    const confirmationTokenHash = await hashToken(confirmationToken);
    const unsubscribeTokenHash = await hashToken(unsubscribeToken);

    const result = await db.execute({
        sql: `
            INSERT INTO waitlist_signups (
                email,
                status,
                opt_in_label,
                signup_ip,
                signup_requested_at,
                confirmation_token_hash,
                confirmation_sent_at,
                confirmed_at,
                confirmed_ip,
                unsubscribe_token_hash,
                unsubscribed_at,
                unsubscribed_ip
            )
            VALUES (?, 'pending', ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL)
            ON CONFLICT(email) DO UPDATE SET
                status = 'pending',
                opt_in_label = excluded.opt_in_label,
                signup_ip = excluded.signup_ip,
                signup_requested_at = excluded.signup_requested_at,
                confirmation_token_hash = excluded.confirmation_token_hash,
                confirmation_sent_at = excluded.confirmation_sent_at,
                confirmed_at = NULL,
                confirmed_ip = NULL,
                unsubscribe_token_hash = excluded.unsubscribe_token_hash,
                unsubscribed_at = NULL,
                unsubscribed_ip = NULL
            WHERE waitlist_signups.status <> 'confirmed'
            RETURNING email
        `,
        args: [
            normalizedEmail,
            WAITLIST_OPT_IN_LABEL,
            requestMeta.clientIp,
            now,
            confirmationTokenHash,
            now,
            unsubscribeTokenHash,
        ],
    });

    if (result.rows.length === 0) {
        return;
    }

    await sendWaitlistConfirmationEmail({
        email: normalizedEmail,
        confirmationToken,
        unsubscribeToken,
        requestMeta,
    });
}

export async function confirmWaitlistSignup(
    token: string,
    requestMeta: WaitlistRequestMeta,
): Promise<WaitlistConfirmationResult> {
    await initSchema();

    const tokenHash = await hashToken(token);
    const confirmationResult = await db.execute({
        sql: `
            UPDATE waitlist_signups
            SET status = 'confirmed',
                confirmed_at = CASE WHEN confirmed_at IS NULL THEN ? ELSE confirmed_at END,
                confirmed_ip = CASE WHEN confirmed_ip IS NULL THEN ? ELSE confirmed_ip END
            WHERE confirmation_token_hash = ?
              AND status = 'pending'
            RETURNING email
        `,
        args: [new Date().toISOString(), requestMeta.clientIp, tokenHash],
    });

    if (confirmationResult.rows.length > 0) {
        return "confirmed";
    }

    const existing = await db.execute({
        sql: "SELECT status FROM waitlist_signups WHERE confirmation_token_hash = ?",
        args: [tokenHash],
    });

    if (existing.rows.length === 0) {
        return "invalid";
    }

    invariant(existing.rows.length === 1, "Expected one waitlist row per confirmation token");
    return existing.rows[0].status === "confirmed" ? "already-confirmed" : "invalid";
}

export async function unsubscribeWaitlistSignup(
    token: string,
    requestMeta: WaitlistRequestMeta,
): Promise<WaitlistUnsubscribeResult> {
    await initSchema();

    const tokenHash = await hashToken(token);
    const unsubscribeResult = await db.execute({
        sql: `
            UPDATE waitlist_signups
            SET status = 'unsubscribed',
                unsubscribed_at = CASE WHEN unsubscribed_at IS NULL THEN ? ELSE unsubscribed_at END,
                unsubscribed_ip = CASE WHEN unsubscribed_ip IS NULL THEN ? ELSE unsubscribed_ip END
            WHERE unsubscribe_token_hash = ?
              AND status <> 'unsubscribed'
            RETURNING email
        `,
        args: [new Date().toISOString(), requestMeta.clientIp, tokenHash],
    });

    if (unsubscribeResult.rows.length > 0) {
        return "unsubscribed";
    }

    const existing = await db.execute({
        sql: "SELECT status FROM waitlist_signups WHERE unsubscribe_token_hash = ?",
        args: [tokenHash],
    });

    if (existing.rows.length === 0) {
        return "invalid";
    }

    invariant(existing.rows.length === 1, "Expected one waitlist row per unsubscribe token");
    return existing.rows[0].status === "unsubscribed" ? "already-unsubscribed" : "invalid";
}
