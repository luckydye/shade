import type { APIRoute } from "astro";
import { db, initSchema } from "../../../../lib/db";

export const prerender = false;

const GITHUB_TOKEN = import.meta.env.GITHUB_TOKEN;

export const GET: APIRoute = async ({ params }) => {
    if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set");

    await initSchema();

    const result = await db.execute({
        sql: "SELECT name, content_type, browser_download_url FROM assets WHERE id = ?",
        args: [params.id!],
    });

    if (result.rows.length === 0) {
        return new Response(JSON.stringify({ error: "Asset not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
        });
    }

    const asset = result.rows[0];

    const upstream = await fetch(asset.browser_download_url as string, {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: "application/octet-stream",
        },
        redirect: "follow",
    });

    if (!upstream.ok) {
        throw new Error(`GitHub returned ${upstream.status}`);
    }

    return new Response(upstream.body, {
        status: 200,
        headers: {
            "Content-Type": asset.content_type as string,
            "Content-Disposition": `attachment; filename="${asset.name}"`,
            "Content-Length": upstream.headers.get("Content-Length") ?? "",
        },
    });
};
