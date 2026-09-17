import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The ETL artefacts are read from disk at runtime with node:fs, so they must be
  // traced into the serverless bundle.
  outputFileTracingIncludes: {
    "/api/**/*": ["./data/processed/**/*"],
    "/": ["./data/processed/**/*"],
  },
};

export default nextConfig;
