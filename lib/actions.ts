"use server";

import { orders } from "@paypal/checkout-server-sdk";
import { getEnvForDomain } from "@/lib/domainenv";
import { getPayPalClient } from "@/lib/paypal";
import { PaymentInfo } from "@/lib/types";
import {
  extractEuroAmount,
  getAmountField,
  getChurchToolsClient,
  getMember,
  getPaidField,
  setPaid,
} from "./churchtools";

export async function getPaymentInfo(
  domain: string,
  groupId: string,
  personId: string,
): Promise<PaymentInfo> {
  const churchToolsClient = getChurchToolsClient(domain);
  const clientId = getEnvForDomain("PAYPAL_CLIENT_ID", domain);
  if (!churchToolsClient || !clientId) {
    return { type: "error", message: "Dieser Link ist leider nicht gültig." };
  }

  const member = await getMember(churchToolsClient, groupId, personId);
  if (!member) {
    return {
      type: "error",
      message:
        "Du bist nicht in der Gruppe, hast du dich inzwischen abgemeldet?",
    };
  }

  const paidField = getPaidField(member);
  if (paidField?.value === "1") {
    return { type: "error", message: "Du hast bereits bezahlt, vielen Dank!" };
  }

  const amountField = getAmountField(member);
  if (!amountField?.value) {
    return {
      type: "error",
      message:
        "Leider kann ich den Zahlungsbetrag nicht bestimmen. Es fehlt das Feld 'Betrag'.",
    };
  }

  const amount = extractEuroAmount(amountField.value);
  if (!amount) {
    return {
      type: "error",
      message:
        "Leider kann ich den Zahlungsbetrag nicht bestimmen. Der Betrag steht nicht im Feld 'Betrag'.",
    };
  }

  return {
    type: "data",
    groupName: member.group.title,
    clientId,
    amount,
  };
}

export async function createPayPalPayment(
  domain: string,
  groupId: string,
  groupName: string,
  personId: string,
) {
  try {
    const client = getPayPalClient(domain);
    const paymentInfo = await getPaymentInfo(domain, groupId, personId);
    if (paymentInfo.type === "error") {
      console.error(paymentInfo.message);
      throw new Error(paymentInfo.message);
    }

    const createRequest = new orders.OrdersCreateRequest();
    createRequest.headers["Prefer"] = "return=representation";
    createRequest.requestBody({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "EUR",
            value: paymentInfo.amount.toFixed(2),
          },
          description: `Anmeldung von Person #${personId} zu ${groupName} (#${groupId})`,
          custom_id: `${groupId}-${personId}`,
        },
      ],
    });
    const response = await client!.execute(createRequest);

    if (response.statusCode !== 201) {
      console.error(
        `PayPal order create error response for domain ${domain}, group ${groupId}, person ${personId}`,
        response,
      );
      throw new Error(
        "Ein Fehler ist aufgetreten. Bitte versuche es später erneut.",
      );
    }

    return response.result.id;
  } catch (err) {
    console.error(
      `Order create error for domain ${domain}, group ${groupId}, person ${personId}`,
      err,
    );
    throw new Error(
      "Ein Fehler ist aufgetreten. Bitte versuche es später erneut.",
    );
  }
}

export async function capturePayPalPayment(
  domain: string,
  groupId: string,
  personId: string,
  orderId: string,
) {
  try {
    const client = getPayPalClient(domain);
    const captureRequest = new orders.OrdersCaptureRequest(orderId);
    const response = await client!.execute(captureRequest);

    if (response.statusCode !== 201) {
      console.error(
        `PayPal order capture error response for domain ${domain}, group ${groupId}, person ${personId}`,
        response,
      );
      throw new Error(
        "Ein Fehler ist aufgetreten. Bitte versuche es später erneut.",
      );
    }

    // Update payment status in ChurchTools
    const churchToolsClient = getChurchToolsClient(domain);
    await setPaid(churchToolsClient!, groupId, personId);
  } catch (err) {
    console.error(
      `Order capture error for domain ${domain}, group ${groupId}, person ${personId}`,
      err,
    );
    throw new Error(
      "Ein Fehler ist aufgetreten. Bitte versuche es später erneut.",
    );
  }
}
