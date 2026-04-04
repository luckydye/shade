import type { APIRoute } from "astro";
import { unsubscribeWaitlistSignup } from "../../../lib/waitlist";

export const prerender = false;

function buildRedirect(request: Request, state: string): Response {
    const redirectUrl = new URL("/", request.url);
    redirectUrl.searchParams.set("waitlist", state);
    return Response.redirect(redirectUrl, 303);
}

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
    const token = url.searchParams.get("token");

    if (!token) {
        return buildRedirect(request, "unsubscribe-error");
    }

    if (!clientAddress) {
        return buildRedirect(request, "unsubscribe-error");
    }

    const result = await unsubscribeWaitlistSignup(token, {
        clientIp: clientAddress,
    });

    if (result === "invalid") {
        return buildRedirect(request, "unsubscribe-error");
    }

    return buildRedirect(request, "unsubscribed");
};
