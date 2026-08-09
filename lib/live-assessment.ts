import { createHash, randomBytes } from 'crypto';

export const tokenHash = (token:string) => createHash('sha256').update(token).digest('hex');
export const newAccessToken = () => randomBytes(32).toString('base64url');
export const newJoinCode = () => {
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes=randomBytes(6);
  return Array.from(bytes,b=>alphabet[b%alphabet.length]).join('');
};

export function bearer(request:Request){
  const value=request.headers.get('authorization') ?? '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}
