import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { formatAmount, type Project } from "../types";

export function ProjectsPage() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => { if (!user) return; api.get<{ projects: Project[] }>("/projects").then((r) => setProjects(r.projects)).catch((e: Error) => setError(e.message)); }, [user]);
  const visible = useMemo(() => projects?.filter((p) => p.title.toLowerCase().includes(query.toLowerCase())) ?? [], [projects, query]);
  if (!user) return <div className="card empty"><p className="eyebrow">Private workspace</p><h2>Connect your wallet to continue</h2><p>Sign in to create secure deals, review milestones, and keep every payment traceable.</p></div>;
  if (error) return <div className="error">{error}</div>;
  if (!projects) return <div className="muted">Loading workspace…</div>;
  const active = projects.filter((p) => !["resolved", "cancelled", "auto_released"].includes(p.status)).length;
  return <>
    <section className="page-heading"><div><p className="eyebrow">Your workspace</p><h1>Deals that move forward.</h1><p>One clear place to protect your work, your payments, and the people you work with.</p></div><Link to="/projects/new"><button>+ Create a deal</button></Link></section>
    <section className="metric-grid"><div className="metric"><span className="metric-label">Total deals</span><strong className="metric-value">{projects.length}</strong></div><div className="metric"><span className="metric-label">In progress</span><strong className="metric-value">{active}</strong></div><div className="metric"><span className="metric-label">Protected volume</span><strong className="metric-value">{projects.reduce((sum, p) => sum + Number(formatAmount(p.totalAmount)), 0).toFixed(2)} <small>units</small></strong></div></section>
    <div className="toolbar"><div><h2>All deals</h2><p className="meta">Track every agreement from funding to release.</p></div><input className="search" aria-label="Search deals" placeholder="Search deals" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
    {visible.length === 0 ? <div className="card empty"><h3>{projects.length ? "No matching deals" : "Your workspace is ready"}</h3><p>{projects.length ? "Try a different search term." : "Create your first agreement and set clear expectations from day one."}</p>{!projects.length && <Link to="/projects/new"><button>Start a deal</button></Link>}</div> : visible.map((p) => <Link className="card card-link row" key={p.id} to={`/projects/${p.id}`}><div><h3>{p.title}</h3><div className="meta">{formatAmount(p.totalAmount)} units · token {p.tokenAddress.slice(0, 10)}…</div></div><span className={`status status-${p.status}`}>{p.status.replaceAll("_", " ")}</span></Link>)}
  </>;
}
