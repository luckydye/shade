import type { APIRoute } from "astro";
import { db, initSchema } from "../../../lib/db";

export const prerender = false;

type GithubAsset = {
    id: number;
    name: string;
    browser_download_url: string;
    content_type: string;
    size: number;
};

type GithubRelease = {
    id: string;
    tag_name: string;
    name: string;
    published_at: string;
    html_url: string;
    assets: GithubAsset[];
};

type GithubWebhookPayload = {
    action: string;
    release: GithubRelease;
};

async function verifySignature(secret: string, body: string, signature: string): Promise<boolean> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const expected = "sha256=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return expected === signature;
}

export const POST: APIRoute = async ({ request }) => {
    const secret = import.meta.env.GITHUB_WEBHOOK_SECRET;
    const signature = request.headers.get("x-hub-signature-256");

    if (!signature) {
        return new Response("Missing signature", { status: 401 });
    }

    const body = await request.text();

    if (!(await verifySignature(secret, body, signature))) {
        return new Response("Invalid signature", { status: 401 });
    }

    const payload = JSON.parse(body) as GithubWebhookPayload;

    if (payload.action !== "published") {
        return new Response("OK", { status: 200 });
    }

    const { release } = payload;

    await initSchema();

    await db.execute({
        sql: `INSERT INTO releases (id, tag_name, name, published_at, html_url)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                tag_name = excluded.tag_name,
                name = excluded.name,
                published_at = excluded.published_at,
                html_url = excluded.html_url`,
        args: [release.id, release.tag_name, release.name, release.published_at, release.html_url],
    });

    await db.execute({
        sql: "DELETE FROM assets WHERE release_id = ?",
        args: [release.id],
    });

    for (const asset of release.assets) {
        await db.execute({
            sql: `INSERT INTO assets (id, release_id, name, browser_download_url, content_type, size)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [asset.id, release.id, asset.name, asset.browser_download_url, asset.content_type, asset.size],
        });
    }

    return new Response("OK", { status: 200 });
};
