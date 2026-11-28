import { NextResponse } from 'next/server';
import { errorResponse, HttpError, readJson, requireRole } from '@/lib/server/auth';
import { backfillAccountNumbers, staffLookup } from '@/lib/server/account-lookup';

export const maxDuration = 60;

/** Staff lookup (#187): ?q= phone, name, company, address, email or account number. Admins and employees. */
export async function GET(req: Request) {
  try {
    await requireRole(req, ['admin', 'employee']);
    const q = (new URL(req.url).searchParams.get('q') || '').trim().slice(0, 100);
    if (q.length < 2) throw new HttpError(400, 'Type at least 2 characters.');
    return NextResponse.json({ results: await staffLookup(q) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return errorResponse(error); }
}

/** { action: 'backfill' }: give every customer and provider an account number (admins). */
export async function POST(req: Request) {
  try {
    await requireRole(req, ['admin']);
    const body = await readJson(req);
    if (body.action !== 'backfill') throw new HttpError(400, 'Unknown action.');
    return NextResponse.json(await backfillAccountNumbers());
  } catch (error) { return errorResponse(error); }
}
