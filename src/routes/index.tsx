import { createFileRoute } from "@tanstack/react-router";
import Index from "@/components/pages/Index";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "4K Smart Solutions — Buy WiFi Access with M-Pesa" },
      {
        name: "description",
        content:
          "Choose a WiFi package, pay with M-Pesa and get connected instantly with an automatic voucher.",
      },
      { property: "og:title", content: "4K Smart Solutions — Buy WiFi Access with M-Pesa" },
      {
        property: "og:description",
        content:
          "Choose a WiFi package, pay with M-Pesa and get connected instantly with an automatic voucher.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});
