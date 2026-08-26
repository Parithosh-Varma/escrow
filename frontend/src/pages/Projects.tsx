import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { formatAmount, type Project } from "../types";

export function ProjectsPage() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    api
      .get<{ projects: Project[] }>("/projects")
      .then((r) => setProjects(r.projects))
      .catch((e: Error) => setError(e.message));
  }, [user]);

  if (!user) {
    return <div className="card">Connect your wallet to sign in and view your projects.</div>;
  }
  if (error) return <div className="error">{error}</div>;
  if (!projects) return <div className="muted">Loading…</div>;

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Your projects</h2>
        <Link to="/projects/new">
          <button>New project</button>
        </Link>
      </div>
      {projects.length === 0 && (
        <div className="card muted">No projects yet. Create one to get started.</div>
      )}
      {projects.map((p) => (
        <Link key={p.id} to={`/projects/${p.id}`}>
          <div className="card row">
            <div>
              <h3>{p.title}</h3>
              <div className="meta">
                {formatAmount(p.totalAmount)} units · token {p.tokenAddress.slice(0, 10)}…
              </div>
            </div>
            <span className={`status status-${p.status}`}>{p.status}</span>
          </div>
        </Link>
      ))}
    </>
  );
}
