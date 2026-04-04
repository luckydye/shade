import type { APIRoute } from "astro";
import { confirmWaitlistSignup } from "../../../lib/waitlist";

export const prerender = false;

function buildRedirect(request: Request, state: string): Response {
    const redirectUrl = new URL("/", request.url);
    redirectUrl.searchParams.set("waitlist", state);
    return Response.redirect(redirectUrl, 303);
}

export const GET: APIRoute = async ({ request, url, clientAddress }) => {
    const token = url.searchParams.get("token");

    if (!token) {
        return buildRedirect(request, "confirm-error");
    }

    if (!clientAddress) {
        return buildRedirect(request, "confirm-error");
    }

    const result = await confirmWaitlistSignup(token, {
        clientIp: clientAddress,
    });

    if (result === "invalid") {
        return buildRedirect(request, "confirm-error");
    }

    return buildRedirect(request, "confirmed");
};
