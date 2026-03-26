import type { APIRoute } from "astro";
import { db, initSchema } from "../../../lib/db";

export const prerender = false;

export const GET: APIRoute = async () => {
    await initSchema();

    const releaseResult = await db.execute(
        "SELECT id, tag_name, name, published_at, html_url FROM releases WHERE prerelease = 0 ORDER BY published_at DESC LIMIT 1",
    );

    if (releaseResult.rows.length === 0) {
        return new Response(JSON.stringify({ error: "No releases found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
        });
    }

    const row = releaseResult.rows[0];

    const assetsResult = await db.execute({
        sql: "SELECT name, browser_download_url FROM assets WHERE release_id = ?",
        args: [row.id as string],
    });

    const release = {
        tag_name: row.tag_name,
        name: row.name,
        assets: assetsResult.rows.map((a) => ({
            name: a.name,
            browser_download_url: a.browser_download_url,
        })),
    };

    return new Response(JSON.stringify(release), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
        },
    });
};
