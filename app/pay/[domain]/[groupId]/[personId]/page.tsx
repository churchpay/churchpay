import { referenceSchema } from "@/lib/config";
import { PaymentPage } from "./payment-page";

export const runtime = "nodejs";
export const maxDuration = 120;

export default async function Page({
  params,
}: {
  params: Promise<{ domain: string; groupId: string; personId: string }>;
}) {
  const access = referenceSchema.safeParse(await params);
  if (!access.success)
    return (
      <main className="mx-auto max-w-xl px-4 py-24">
        <h1 className="text-xl font-bold">Ungültiger Zahlungslink</h1>
        <p>Bitte verwende einen aktuellen Link aus deiner Bestätigungsmail.</p>
      </main>
    );
  return <PaymentPage key={JSON.stringify(access.data)} access={access.data} />;
}
