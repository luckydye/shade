type ReleaseAsset = {
    browser_download_url: string;
    name: string;
};

type Release = {
    assets: ReleaseAsset[];
    name: string;
    tag_name: string;
};

type Os = "linux" | "macos" | "windows";
type Arch = "arm64" | "x64";

type PlatformTarget = {
    arch: Arch;
    os: Os;
};

type AssetRule = {
    extension: string;
    tokens: string[];
};

type NavigatorWithUserAgentData = Navigator & {
    userAgentData?: {
        getHighEntropyValues?: (
            hints: string[],
        ) => Promise<{ architecture?: string; bitness?: string }>;
        platform?: string;
    };
};

const IS_PRERELEASE = new URLSearchParams(window.location.search).get("release") === "pre";
const RELEASE_URL = IS_PRERELEASE ? "/api/releases/latest?prerelease=1" : "/api/releases/latest";

const PLATFORM_LABELS: Record<Os, string> = {
    linux: "Linux",
    macos: "macOS",
    windows: "Windows",
};

const ASSET_RULES: Record<Os, Record<Arch, AssetRule[]>> = {
    linux: {
        arm64: [
            { extension: ".AppImage", tokens: ["aarch64", "arm64"] },
            { extension: ".deb", tokens: ["aarch64", "arm64"] },
            { extension: ".rpm", tokens: ["aarch64", "arm64"] },
        ],
        x64: [
            { extension: ".AppImage", tokens: ["amd64", "x64", "x86_64"] },
            { extension: ".deb", tokens: ["amd64", "x64", "x86_64"] },
            { extension: ".rpm", tokens: ["amd64", "x64", "x86_64"] },
        ],
    },
    macos: {
        arm64: [
            { extension: ".dmg", tokens: ["aarch64", "arm64"] },
            { extension: ".app.tar.gz", tokens: ["aarch64", "arm64"] },
        ],
        x64: [
            { extension: ".dmg", tokens: ["amd64", "x64", "x86_64"] },
            { extension: ".app.tar.gz", tokens: ["amd64", "x64", "x86_64"] },
        ],
    },
    windows: {
        arm64: [
            { extension: ".exe", tokens: ["arm64", "aarch64"] },
            { extension: ".msi", tokens: ["arm64", "aarch64"] },
        ],
        x64: [
            { extension: ".exe", tokens: ["amd64", "x64", "x86_64"] },
            { extension: ".msi", tokens: ["amd64", "x64", "x86_64"] },
        ],
    },
};

function normalizeArch(
    architecture: string | undefined,
    bitness?: string,
): Arch | null {
    if (!architecture) {
        return null;
    }

    const value = architecture.toLowerCase();

    if (value === "arm64" || value === "aarch64" || value === "arm") {
        return "arm64";
    }

    if (
        value === "x64" ||
        value === "amd64" ||
        value === "x86_64" ||
        (value === "x86" && bitness === "64")
    ) {
        return "x64";
    }

    return null;
}

function detectOs(platformHint: string): Os | null {
    const normalized = platformHint.toLowerCase();

    if (normalized.includes("win")) {
        return "windows";
    }

    if (normalized.includes("mac")) {
        return "macos";
    }

    if (normalized.includes("linux")) {
        return "linux";
    }

    return null;
}

function detectArchFromUserAgent(userAgent: string): Arch | null {
    const normalized = userAgent.toLowerCase();

    if (normalized.includes("arm64") || normalized.includes("aarch64")) {
        return "arm64";
    }

    if (
        normalized.includes("x86_64") ||
        normalized.includes("amd64") ||
        normalized.includes("win64") ||
        normalized.includes("x64")
    ) {
        return "x64";
    }

    return null;
}

async function detectPlatform(): Promise<PlatformTarget | null> {
    const navigatorWithUserAgentData = navigator as NavigatorWithUserAgentData;
    const os =
        detectOs(navigatorWithUserAgentData.userAgentData?.platform ?? "") ??
        detectOs(navigator.platform) ??
        detectOs(navigator.userAgent);

    if (!os) {
        return null;
    }

    const userAgentArch = detectArchFromUserAgent(navigator.userAgent);

    if (userAgentArch) {
        return { arch: userAgentArch, os };
    }

    const highEntropyValues =
        await navigatorWithUserAgentData.userAgentData?.getHighEntropyValues?.([
            "architecture",
            "bitness",
        ]);
    const highEntropyArch = normalizeArch(
        highEntropyValues?.architecture,
        highEntropyValues?.bitness,
    );

    if (!highEntropyArch) {
        return null;
    }

    return { arch: highEntropyArch, os };
}

function matchesRule(assetName: string, rule: AssetRule): boolean {
    const normalized = assetName.toLowerCase();
    const normalizedExtension = rule.extension.toLowerCase();

    return (
        normalized.endsWith(normalizedExtension) &&
        rule.tokens.some((token) => normalized.includes(token))
    );
}

function pickReleaseAsset(
    assets: ReleaseAsset[],
    target: PlatformTarget,
): ReleaseAsset | null {
    for (const rule of ASSET_RULES[target.os][target.arch]) {
        const match = assets.find((asset) => matchesRule(asset.name, rule));

        if (match) {
            return match;
        }
    }

    return null;
}

async function fetchLatestRelease(): Promise<Release> {
    const response = await fetch(RELEASE_URL);

    if (!response.ok) {
        throw new Error(`Release request failed with status ${response.status}.`);
    }

    const release = (await response.json()) as Release;

    if (!Array.isArray(release.assets)) {
        throw new Error("Latest release response did not include assets.");
    }

    return release;
}

const BUTTON_CLASS =
    "inline-flex leading-10 gap-2 rounded-full border px-8 text-[14px] font-semibold transition-colors backdrop-blur-sm";

class DownloadCtaElement extends HTMLElement {
    link: HTMLAnchorElement;
    fallback: HTMLSpanElement;

    constructor() {
        super();

        this.link = document.createElement("a");
        this.link.className = `${BUTTON_CLASS} border-white/12 bg-white text-black hover:bg-white/88`;
        this.link.style.display = "none";
        this.link.rel = "noreferrer";
        this.link.target = "_blank";
        this.link.textContent = "Download";

        this.fallback = document.createElement("span");
        this.fallback.className = `${BUTTON_CLASS} cursor-not-allowed border-white/12 bg-white/[0.08] text-white/45`;
        this.fallback.setAttribute("aria-disabled", "true");
        this.fallback.textContent = this.getAttribute("unavailable-label") ?? "Coming soon";

        this.append(this.link, this.fallback);
    }

    async connectedCallback(): Promise<void> {
        const target = await detectPlatform();

        if (!target) {
            this.fallback.textContent = "Platform unsupported";
            return;
        }

        try {
            const release = await fetchLatestRelease();
            const asset = pickReleaseAsset(release.assets, target);

            if (!asset) {
                this.fallback.textContent = "Not available for your platform";
                return;
            }

            this.link.href = asset.browser_download_url;
            const label = IS_PRERELEASE
                ? `Download ${release.tag_name} for ${PLATFORM_LABELS[target.os]}`
                : `Download for ${PLATFORM_LABELS[target.os]}`;
            this.link.textContent = label;
            this.link.style.display = "";
            this.fallback.style.display = "none";
        } catch (error) {
            this.fallback.textContent = this.getAttribute("unavailable-label") ?? "Coming soon";
            throw error;
        }
    }
}

customElements.define("download-cta", DownloadCtaElement);
