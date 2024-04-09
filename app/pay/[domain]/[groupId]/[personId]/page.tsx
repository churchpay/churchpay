"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";
import {
  capturePayPalPayment,
  createPayPalPayment,
  getPaymentInfo,
} from "@/lib/actions";

export default function PayPage() {
  const { domain, groupId, personId } = useParams() as {
    domain: string;
    groupId: string;
    personId: string;
  };

  const [error, setError] = useState<string | null>();
  const [success, setSuccess] = useState<boolean>(false);
  const [groupName, setGroupName] = useState<string | null>();
  const [clientId, setClientId] = useState<string | null>();

  useEffect(() => {
    getPaymentInfo(domain, groupId, personId).then((paymentInfo) => {
      if (paymentInfo.type === "error") {
        setError(paymentInfo.message);
      }
      if (paymentInfo.type === "data") {
        setGroupName(paymentInfo.groupName);
        setClientId(paymentInfo.clientId);
      }
    });
  }, [domain, groupId, personId]);

  if (error) {
    return (
      <main className="flex flex-col items-center gap-4 p-24">
        <h1 className="text-xl font-bold">Ein Fehler ist aufgetreten</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (success) {
    return (
      <main className="flex flex-col items-center gap-4 p-24">
        <h1 className="text-xl font-bold">Vielen Dank!</h1>
        <p>Deine Zahlung war erfolgreich.</p>
      </main>
    );
  }

  if (groupName && clientId) {
    return (
      <main className="flex flex-col items-center gap-8 px-4 py-24">
        <h1 className="text-xl font-bold">Bezahlen für {groupName}</h1>
        <PayPalScriptProvider
          options={{
            clientId,
            currency: "EUR",
            intent: "capture",
          }}
        >
          <PayPalButtons
            style={{
              color: "gold",
              shape: "rect",
              label: "pay",
              height: 50,
            }}
            className="w-72 max-w-full"
            createOrder={async () => {
              try {
                const orderId = await createPayPalPayment(
                  domain,
                  groupId,
                  personId,
                );
                return orderId;
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onApprove={async (data) => {
              try {
                await capturePayPalPayment(
                  domain,
                  groupId,
                  personId,
                  data.orderID,
                );
                setSuccess(true);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        </PayPalScriptProvider>
      </main>
    );
  }

  return (
    <main className="flex flex-col items-center gap-4 p-24">
      <div className="h-10 w-48 animate-pulse rounded-md bg-stone-100 dark:bg-stone-800" />
      <div className="h-20 w-full max-w-screen-md animate-pulse rounded-md bg-stone-100 dark:bg-stone-800" />
    </main>
  );
}
