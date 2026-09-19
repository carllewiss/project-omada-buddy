import { createFileRoute } from "@tanstack/react-router";
import Admin from "@/components/pages/Admin";

export const Route = createFileRoute("/admin")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sales Admin — 4K Smart Solutions" },
      {
        name: "description",
        content: "Review M-Pesa transactions, voucher codes and send voucher SMS to customers.",
      },
      { property: "og:title", content: "Sales Admin — 4K Smart Solutions" },
      {
        property: "og:description",
        content: "Review M-Pesa transactions, voucher codes and send voucher SMS to customers.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Admin,
});
