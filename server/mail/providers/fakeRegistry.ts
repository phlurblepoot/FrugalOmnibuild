import { FakeMailProvider } from './fake';
const fakes = new Map<string, FakeMailProvider>();
export function getFakeProvider(accountId: string): FakeMailProvider {
  let p = fakes.get(accountId); if (!p) { p = new FakeMailProvider(); p.seed([]); fakes.set(accountId, p); } return p;
}
export function resetFakes(): void { fakes.clear(); }
