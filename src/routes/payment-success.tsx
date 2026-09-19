import { createFileRoute } from "@tanstack/react-router";
import PaymentSuccess from "@/components/pages/PaymentSuccess";

export const Route = createFileRoute("/payment-success")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Payment Successful — 4K Smart Solutions" },
      {
        name: "description",
        content: "Your M-Pesa payment was received. View and download your WiFi voucher code.",
      },
      { property: "og:title", content: "Payment Successful — 4K Smart Solutions" },
      {
        property: "og:description",
        content: "Your M-Pesa payment was received. View and download your WiFi voucher code.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PaymentSuccess,
});
