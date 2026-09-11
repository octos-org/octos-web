import { useProjectDiscovery } from "@/store/project-discovery";

export function ProjectDiscoveryStatus() {
  const { loading, error, retry } = useProjectDiscovery();
  if (loading) return <p role="status" className="px-6 py-2 text-sm text-muted">Loading saved projects…</p>;
  if (!error) return null;
  return (
    <div role="alert" className="flex items-center gap-3 px-6 py-2 text-sm">
      <span>{error}</span>
      <button type="button" onClick={retry} className="underline">Retry</button>
    </div>
  );
}
