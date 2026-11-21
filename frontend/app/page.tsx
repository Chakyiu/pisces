// Placeholder shell. The real navigation and views come from the UI/UX spec (TELE-71).

const API_BASE = process.env.PISCES_API_URL ?? "http://127.0.0.1:8787";

async function getHealth(): Promise<string> {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { cache: "no-store" });
    if (!res.ok) return `backend responded ${res.status}`;
    const body = (await res.json()) as { status?: string };
    return `backend ${body.status ?? "unknown"}`;
  } catch {
    return "backend unreachable";
  }
}

export default async function Home() {
  const health = await getHealth();

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", maxWidth: 720 }}>
      <h1 style={{ margin: 0 }}>Pisces</h1>
      <p>Scaffold only — views land after the layout spec is approved.</p>
      <p style={{ color: health.startsWith("backend ok") ? "#0a7" : "#b00" }}>{health}</p>
    </main>
  );
}
