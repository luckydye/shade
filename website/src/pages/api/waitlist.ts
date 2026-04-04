import type { APIRoute } from "astro";
import { WAITLIST_OPT_IN_LABEL, submitWaitlistSignup } from "../../lib/waitlist";

export const prerender = false;

function json(body: Record<string, string>, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
        },
    });
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
    const formData = await request.formData();
    const email = formData.get("email");
    const optIn = formData.get("productLaunchOptIn");

    if (typeof email !== "string" || email.trim().length === 0) {
        return json({ error: "Please enter your email address." }, 400);
    }

    if (optIn !== WAITLIST_OPT_IN_LABEL) {
        return json({ error: "Please confirm email updates for the product launch." }, 400);
    }

    if (!clientAddress) {
        return json({ error: "Client IP is required for double opt-in." }, 500);
    }

    await submitWaitlistSignup(email, {
        clientIp: clientAddress,
    });

    return json(
        {
            message: "Check your inbox and confirm your email to join the waitlist.",
        },
        202,
    );
};
