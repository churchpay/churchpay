import { loadQuote, setPaid } from "./churchtools";
import { getTenant } from "./config";
import { PaymentService } from "./payment-service";
import { postgresStore } from "./payment-store";
import { paypalGateway } from "./paypal";

export function paymentService(domain: string) {
  const tenant = getTenant(domain);
  return new PaymentService({
    store: postgresStore(),
    paypal: paypalGateway(tenant),
    quote: loadQuote,
    setPaid,
    merchantId: tenant.merchantId,
    clientId: tenant.clientId,
    log: (event, paymentId) =>
      console.error(JSON.stringify({ event, paymentId })),
  });
}
