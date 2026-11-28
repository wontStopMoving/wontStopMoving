'use client';

import { useState } from 'react';
import Link from 'next/link';
import { EmployeeLayout } from '@/components/layout/employee-layout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useAuth, useDoc, useFirestore, useMemoFirebase, useUser } from '@/firebase';
import { doc } from 'firebase/firestore';
import { apiFetch } from '@/lib/api-client';
import type { LookupHit } from '@/lib/account-lookup';

const MATCHED: Record<LookupHit['matched'], string> = { account: 'Account number', phone: 'Phone', email: 'Email', name: 'Name', company: 'Company', address: 'Address' };
const prettyPhone = (p: string) => { const d = p.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; };

/** Staff lookup (#187): find a customer or provider by phone, name, company, address, email or account number. */
export default function LookupPage() {
  const auth = useAuth(), firestore = useFirestore(), { user } = useUser();
  const profileRef = useMemoFirebase(() => (user ? doc(firestore, 'users', user.uid) : null), [firestore, user]);
  const { data: profile } = useDoc(profileRef);
  const isAdmin = profile?.role === 'admin';
  const [q, setQ] = useState(''), [results, setResults] = useState<LookupHit[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(''), [notice, setNotice] = useState('');

  async function search(e: React.FormEvent) {
    e.preventDefault(); setError(''); setBusy('search');
    try { setResults((await apiFetch<{ results: LookupHit[] }>(auth, `/api/admin/lookup?q=${encodeURIComponent(q.trim())}`)).results); }
    catch (err) { setError(err instanceof Error ? err.message : 'Search failed.'); setResults(null); }
    finally { setBusy(''); }
  }
  async function backfill() {
    setBusy('backfill'); setNotice('');
    try {
      const r = await apiFetch<{ assigned: number; remaining: number; total: number }>(auth, '/api/admin/lookup', { action: 'backfill' });
      setNotice(r.remaining ? `Assigned ${r.assigned}; ${r.remaining} still need one. Run it again to finish.` : `Done. All ${r.total} customer and provider accounts have an account number${r.assigned ? ` (${r.assigned} new)` : ''}.`);
    } catch (err) { setNotice(err instanceof Error ? err.message : 'That didn’t work.'); }
    finally { setBusy(''); }
  }

  return <EmployeeLayout isAdmin={isAdmin}><main className="space-y-5 max-w-4xl">
    <h1 className="text-3xl font-bold">Look up an account</h1>
    <p className="text-sm text-muted-foreground">Find a customer or provider by phone (any format, or the last 4 digits), name, company, street address, email, or account number like WSM-48213.</p>
    <form onSubmit={search} className="flex flex-col sm:flex-row gap-2">
      <Input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Phone, name, address, email or WSM-#####" aria-label="Search accounts" maxLength={100} />
      <Button type="submit" disabled={busy === 'search' || q.trim().length < 2}>{busy === 'search' ? 'Searching…' : 'Search'}</Button>
    </form>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {results && !results.length && <p className="text-muted-foreground">No customers or providers match “{q.trim()}”.</p>}
    {results && results.length > 0 && <p className="text-sm text-muted-foreground">{results.length === 50 ? 'First 50 matches' : `${results.length} match${results.length === 1 ? '' : 'es'}`}</p>}
    <div className="space-y-3">{(results || []).map(r => {
      const href = r.role === 'customer' ? `/dashboard/admin/customers/${r.uid}` : `/dashboard/admin/providers?status=all#provider-${r.uid}`;
      return <Card key={r.uid} className="bg-white"><CardContent className="p-4 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {/* Profiles open for admins; employees see the contact details here. */}
          {isAdmin ? <Link href={href} className="font-bold text-primary underline">{r.company || r.name || r.email || 'Unnamed account'}</Link> : <span className="font-bold text-primary">{r.company || r.name || r.email || 'Unnamed account'}</span>}
          {r.company && r.name && <span className="text-sm text-muted-foreground">{r.name}</span>}
          <Badge variant="outline" className="capitalize">{r.role}</Badge>
          {r.accountNumber && <Badge variant="secondary">{r.accountNumber}</Badge>}
          <span className="text-xs text-muted-foreground">Matched: {MATCHED[r.matched]}</span>
        </div>
        <p className="text-sm text-muted-foreground break-words">{[r.email, ...r.phones.map(prettyPhone)].filter(Boolean).join(' · ')}</p>
        {r.addresses.length > 0 && <p className="text-sm text-muted-foreground break-words">{r.addresses.join(' · ')}</p>}
      </CardContent></Card>;
    })}</div>
    {isAdmin && <Card className="bg-white"><CardContent className="p-4 space-y-2 text-sm">
      <p className="font-bold">Account numbers</p>
      <p className="text-muted-foreground">New accounts get a number the first time they open their dashboard. Give every existing customer and provider one now:</p>
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void backfill()}>{busy === 'backfill' ? 'Assigning…' : 'Assign missing account numbers'}</Button>
      {notice && <p role="status">{notice}</p>}
    </CardContent></Card>}
  </main></EmployeeLayout>;
}
