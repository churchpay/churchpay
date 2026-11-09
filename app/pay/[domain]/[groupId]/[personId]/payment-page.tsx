"use client";

import { useEffect, useRef, useState } from "react";
import {
  PayPalButtons,
  PayPalScriptProvider,
  usePayPalScriptReducer,
} from "@paypal/react-paypal-js";
import {
  capturePayPalPayment,
  createPayPalPayment,
  getPaymentInfo,
} from "@/lib/actions";
import type { PaymentReference } from "@/lib/config";
import type { PaymentInfo, PaymentResult } from "@/lib/types";

const unavailable = {
  type: "error" as const,
  message:
    "Die Zahlung konnte nicht verarbeitet werden. Bitte versuche es später erneut. Bereits bestätigte Zahlungen werden automatisch abgeglichen.",
};

function Checkout({
  access,
  update,
}: {
  access: PaymentReference;
  update(info: PaymentInfo): void;
}) {
  const [{ isRejected }] = usePayPalScriptReducer();
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);
  if (isRejected)
    return (
      <p role="alert">
        PayPal konnte nicht geladen werden. Bitte lade die Seite erneut.
      </p>
    );
  return (
    <PayPalButtons
      disabled={busy}
      className="w-72 max-w-full"
      style={{ color: "gold", shape: "rect", label: "pay", height: 50 }}
      createOrder={async () => {
        setBusy(true);
        handled.current = false;
        try {
          const result = await createPayPalPayment(access);
          if (result.type !== "order") {
            handled.current = true;
            update(result);
            throw new Error("Payment is unavailable");
          }
          return result.orderId;
        } finally {
          setBusy(false);
        }
      }}
      onApprove={async (data) => {
        setBusy(true);
        try {
          update(await capturePayPalPayment(access, data.orderID));
        } catch {
          update(unavailable);
        } finally {
          setBusy(false);
        }
      }}
      onCancel={() => {
        setBusy(false);
      }}
      onError={() => {
        setBusy(false);
        if (!handled.current) update(unavailable);
      }}
    />
  );
}

function Status({ result }: { result: PaymentResult }) {
  if (result.status === "completed")
    return (
      <>
        <h1 className="text-xl font-bold">Vielen Dank!</h1>
        <p>Deine Zahlung wurde bestätigt.</p>
        {!result.synced && (
          <p>
            Der Eintrag in ChurchTools wird noch aktualisiert. Du musst nicht
            erneut bezahlen.
          </p>
        )}
      </>
    );
  if (result.status === "refunded" || result.status === "reversed")
    return (
      <>
        <h1 className="text-xl font-bold">Zahlung zurückgebucht</h1>
        <p>Bitte wende dich bei Fragen an den Veranstalter.</p>
      </>
    );
  if (result.status === "review")
    return (
      <>
        <h1 className="text-xl font-bold">Zahlung wird geprüft</h1>
        <p>
          Bitte wende dich an den Veranstalter. Starte keine weitere Zahlung.
        </p>
      </>
    );
  return (
    <>
      <h1 className="text-xl font-bold">Zahlung wird verarbeitet</h1>
      <p>
        Die Bestätigung steht noch aus. Der Status wird automatisch
        aktualisiert. Bitte bezahle nicht erneut.
      </p>
    </>
  );
}

export function PaymentPage({ access }: { access: PaymentReference }) {
  const [info, setInfo] = useState<PaymentInfo | null>(null);
  useEffect(() => {
    let active = true;
    getPaymentInfo(access)
      .then((value) => {
        if (active) setInfo(value);
      })
      .catch(() => {
        if (active) setInfo(unavailable);
      });
    return () => {
      active = false;
    };
  }, [access]);
  useEffect(() => {
    if (
      info?.type !== "status" ||
      ["review", "refunded", "reversed"].includes(info.status) ||
      (info.status === "completed" && info.synced)
    )
      return;
    let active = true;
    const timer = setTimeout(() => {
      getPaymentInfo(access)
        .then((value) => {
          if (active) setInfo(value);
        })
        .catch(() => {
          if (active) setInfo(unavailable);
        });
    }, 10000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [access, info]);

  return (
    <main
      className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-24"
      aria-live="polite"
    >
      {!info && <p role="status">Zahlungsinformationen werden geladen …</p>}
      {info?.type === "error" && (
        <>
          <h1 className="text-xl font-bold">Zahlung derzeit nicht verfügbar</h1>
          <p role="alert">{info.message}</p>
        </>
      )}
      {info?.type === "status" && <Status result={info} />}
      {info?.type === "data" && (
        <>
          <h1 className="text-xl font-bold">Bezahlen für {info.groupName}</h1>
          <p className="mb-4 font-bold">
            {new Intl.NumberFormat("de-DE", {
              style: "currency",
              currency: "EUR",
            }).format(info.amountCents / 100)}
          </p>
          <PayPalScriptProvider
            options={{
              clientId: info.clientId,
              currency: "EUR",
              intent: "capture",
            }}
          >
            <Checkout access={access} update={setInfo} />
          </PayPalScriptProvider>
        </>
      )}
    </main>
  );
}
