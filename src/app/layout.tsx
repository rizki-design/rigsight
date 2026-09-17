import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RigSight - SEBL_002 / PHR-026",
  description:
    "Real-time drilling telemetry dashboard and anomaly-detection API built on five days of anonymised rig data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
