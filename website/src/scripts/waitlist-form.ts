const flashMessages: Record<string, { text: string; tone: "success" | "error" }> = {
    confirmed: {
        text: "Your email address is confirmed. You are on the waitlist.",
        tone: "success",
    },
    "confirm-error": {
        text: "That confirmation link is invalid or expired.",
        tone: "error",
    },
    unsubscribed: {
        text: "You have been unsubscribed from launch emails.",
        tone: "success",
    },
    "unsubscribe-error": {
        text: "That unsubscribe link is invalid or expired.",
        tone: "error",
    },
};

function setFeedback(target: HTMLElement, text: string, tone: "success" | "error" | "neutral"): void {
    target.textContent = text;
    target.classList.remove("text-white/70", "text-[#8fd19e]", "text-[#ff8b7a]");

    if (tone === "success") {
        target.classList.add("text-[#8fd19e]");
        return;
    }

    if (tone === "error") {
        target.classList.add("text-[#ff8b7a]");
        return;
    }

    target.classList.add("text-white/70");
}

function clearWaitlistFlashFromUrl(): void {
    const url = new URL(window.location.href);
    url.searchParams.delete("waitlist");
    window.history.replaceState({}, "", url);
}

function disableForm(form: HTMLFormElement, disabled: boolean): void {
    for (const element of Array.from(form.elements)) {
        if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement) {
            element.disabled = disabled;
        }
    }
}

function initWaitlistForm(form: HTMLFormElement): void {
    const feedback = form.querySelector<HTMLElement>("[data-waitlist-feedback]");

    if (!feedback) {
        throw new Error("Waitlist feedback element is required");
    }

    const waitlistState = new URL(window.location.href).searchParams.get("waitlist");
    if (waitlistState) {
        const flash = flashMessages[waitlistState];
        if (flash) {
            setFeedback(feedback, flash.text, flash.tone);
        }
        clearWaitlistFlashFromUrl();
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        disableForm(form, true);
        setFeedback(feedback, "Sending confirmation email...", "neutral");

        try {
            const response = await fetch("/api/waitlist", {
                method: "POST",
                body: new FormData(form),
            });

            const body = (await response.json()) as { error?: string; message?: string };

            if (!response.ok) {
                if (typeof body.error !== "string" || body.error.length === 0) {
                    throw new Error("Waitlist signup failed");
                }

                throw new Error(body.error);
            }

            if (typeof body.message !== "string" || body.message.length === 0) {
                throw new Error("Waitlist success response is missing a message");
            }

            form.reset();
            setFeedback(feedback, body.message, "success");
        } catch (error) {
            const message = error instanceof Error ? error.message : "Waitlist signup failed";
            setFeedback(feedback, message, "error");
        } finally {
            disableForm(form, false);
        }
    });
}

const waitlistForm = document.querySelector<HTMLFormElement>("[data-waitlist-form]");

if (waitlistForm) {
    initWaitlistForm(waitlistForm);
}
