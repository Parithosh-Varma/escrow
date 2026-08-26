import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { DEFAULT_TOKEN } from "../types";

export function CreateProjectPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [amount, setAmount] = useState(""); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { const result = await api.post<{ project: { id: string } }>("/projects", { title, description, totalAmount: amount, tokenAddress: DEFAULT_TOKEN }); navigate(`/projects/${result.project.id}`); } catch (e) { setError((e as Error).message); } finally { setSaving(false); } }
  return <section><p className="eyebrow">New agreement</p><h1>Set the terms clearly.</h1><p className="muted">Define the scope and value before inviting the other side.</p><form className="card form" onSubmit={submit}><label htmlFor="title">Deal title</label><input id="title" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Brand identity redesign" /><label htmlFor="description">What is being delivered?</label><textarea id="description" required rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the scope, expectations, and definition of done." /><label htmlFor="amount">Total amount (base units)</label><input id="amount" required inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000000" />{error && <p className="error">{error}</p>}<div className="form-actions"><Link to="/"><button type="button" className="secondary">Cancel</button></Link><button disabled={saving}>{saving ? "Creating…" : "Create agreement"}</button></div></form></section>;
}
