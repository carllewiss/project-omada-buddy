import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "4K Smart Solutions — Captive Portal Package" },
      {
        name: "description",
        content:
          "Preview and download the 4K Smart Solutions Omada captive portal: M-Pesa payments, voucher redemption and automatic WiFi login.",
      },
      { property: "og:title", content: "4K Smart Solutions — Captive Portal Package" },
      {
        property: "og:description",
        content:
          "Preview and download the 4K Smart Solutions Omada captive portal: M-Pesa payments, voucher redemption and automatic WiFi login.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            4K Smart Solutions — Omada Captive Portal
          </h1>
          <p className="mt-2 text-muted-foreground">
            The portal page is bundled as plain HTML, CSS and JavaScript so it can be uploaded
            straight to your Omada Controller. It keeps the existing backend and payment setup.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold text-card-foreground">Preview the page</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            M-Pesa and voucher login only work once the page runs on the controller.
          </p>
          <a
            className="mt-4 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            href="/portal/index.html"
            target="_blank"
            rel="noopener"
          >
            Open portal preview
          </a>
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold text-card-foreground">Upload to Omada</h2>
          <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>1. Omada Controller → Settings → Authentication → Portal Customization</li>
            <li>2. Pick the internal portal whose authentication type is Voucher</li>
            <li>3. Upload the ZIP file</li>
            <li>4. Bind the portal to your WiFi networks</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
