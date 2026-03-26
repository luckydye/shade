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
    `);

    try {
        await db.execute("ALTER TABLE releases ADD COLUMN prerelease INTEGER NOT NULL DEFAULT 0");
    } catch (e: unknown) {
        // column already exists — ignore
        if (!(e instanceof Error) || !e.message.includes("duplicate column")) throw e;
    }
}
