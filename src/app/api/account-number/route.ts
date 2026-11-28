import { NextResponse } from 'next/server';
import { errorResponse, getRole, HttpError, requireUser } from '@/lib/server/auth';
import { accountNumberFor } from '@/lib/server/account-lookup';

/** The signed-in customer's or provider's account number, assigned on first request (#187). */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const role = await getRole(user.uid);
    if (role !== 'customer' && role !== 'provider') throw new HttpError(403, 'Account numbers are for customer and provider accounts.');
    return NextResponse.json({ accountNumber: await accountNumberFor(user.uid) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return errorResponse(error); }
}
