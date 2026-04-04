import { createClient } from "@libsql/client";

export const db = createClient({
    url: import.meta.env.TURSO_DATABASE_URL,
    authToken: import.meta.env.TURSO_AUTH_TOKEN,
});

export async function initSchema(): Promise<void> {
    await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS releases (
            id TEXT PRIMARY KEY,
            tag_name TEXT NOT NULL,
            name TEXT NOT NULL,
            published_at TEXT NOT NULL,
            html_url TEXT NOT NULL,
            prerelease INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS assets (
            id INTEGER PRIMARY KEY,
            release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            browser_download_url TEXT NOT NULL,
            content_type TEXT NOT NULL,
            size INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS waitlist_signups (
            email TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
            opt_in_label TEXT NOT NULL,
            signup_ip TEXT NOT NULL,
            signup_requested_at TEXT NOT NULL,
            confirmation_token_hash TEXT NOT NULL,
            confirmation_sent_at TEXT NOT NULL,
            confirmed_at TEXT,
            confirmed_ip TEXT,
            unsubscribe_token_hash TEXT NOT NULL,
            unsubscribed_at TEXT,
            unsubscribed_ip TEXT,
            CHECK (email = lower(email))
        );
        CREATE INDEX IF NOT EXISTS idx_waitlist_confirmation_token_hash
            ON waitlist_signups (confirmation_token_hash);
        CREATE INDEX IF NOT EXISTS idx_waitlist_unsubscribe_token_hash
            ON waitlist_signups (unsubscribe_token_hash);
    `);

    try {
        await db.execute("ALTER TABLE releases ADD COLUMN prerelease INTEGER NOT NULL DEFAULT 0");
    } catch (e: unknown) {
        // column already exists — ignore
        if (!(e instanceof Error) || !e.message.includes("duplicate column")) throw e;
    }
}
