import Dashboard from "@/components/dashboard";
import { buildPayload } from "@/lib/payload";

/**
 * Server component: reads the ETL artefacts on the server and hands the dashboard a
 * payload that is already aggregated. The browser never sees the 10 MB minute table.
 */
export default function Page() {
  return <Dashboard data={buildPayload()} />;
}
