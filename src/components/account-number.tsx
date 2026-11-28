'use client';

import { useEffect, useState } from 'react';
import { useAuth, useUser } from '@/firebase';
import { apiFetch } from '@/lib/api-client';

/** The customer's or provider's account number (#187), to read to staff over the phone. */
export function AccountNumber({ className = '' }: { className?: string }) {
  const auth = useAuth(), { user } = useUser();
  const [number, setNumber] = useState('');
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    apiFetch<{ accountNumber: string }>(auth, '/api/account-number').then(r => { if (!cancelled) setNumber(r.accountNumber); }).catch(() => {});
    return () => { cancelled = true; };
  }, [auth, user]);
  if (!number) return null;
  return <p className={`text-sm text-muted-foreground ${className}`}>Account number: <b className="font-mono text-foreground tracking-wide">{number}</b> <span className="text-xs">(give this to our team when you call)</span></p>;
}
