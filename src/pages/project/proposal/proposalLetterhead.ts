// src/pages/project/proposal/proposalLetterhead.ts
// Resolves the branded letterhead context (brand colour, company block, logo)
// from the app settings so every proposal render — download, preview, email —
// builds it the same way instead of re-inlining the logo/invert dance.
import { hexToRgb, invertImageDataUrl } from '../../../utils/documentLetterhead';
import type { LetterheadContext } from '../../../utils/documentLetterhead';

/**
 * Build the letterhead context for a proposal PDF.
 *
 * `headerEmail` overrides the company email shown in the header (used when the
 * sender picks a different from-address at send time). A logo that isn't already
 * a data URL is fetched and inlined; any failure just drops the logo — a missing
 * logo must never fail the render.
 */
export async function buildLetterhead(
  settings: Record<string, string>,
  headerEmail?: string,
): Promise<LetterheadContext> {
  let logoDataUrl: string | undefined = settings.logoUrl || undefined;
  if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
    try {
      const blob = await (await fetch(logoDataUrl)).blob();
      logoDataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(new Error('logo read failed'));
        fr.readAsDataURL(blob);
      });
    } catch {
      logoDataUrl = undefined;
    }
  }
  if (logoDataUrl && settings.invertLogoOnDocuments === 'true') {
    logoDataUrl = await invertImageDataUrl(logoDataUrl);
  }
  return {
    brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'),
    company: {
      name: settings.companyName || settings.appName,
      phone: settings.companyPhone,
      email: headerEmail || settings.companyEmail,
      address: settings.companyAddress,
    },
    logoDataUrl,
  };
}
