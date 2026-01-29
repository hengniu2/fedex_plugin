import { QuoteMockApi } from "./quote-mock-api.js";

const singleRequestExample = {
  carrierCode: "fedex",
  serviceCode: "fedex_ground",
  packageTypeCode: "fedex_custom_package",
  sender: {
    country: "US",
    zip: "80224",
  },
  receiver: {
    city: "Los Angeles",
    country: "US",
    zip: "77077",
    email: "foo@bar.com",
  },
  residential: true,
  signatureOptionCode: "DIRECT",
  contentDescription: "Test shipment – overnight",
  weightUnit: "lb",
  dimUnit: "in",
  currency: "USD",
  customsCurrency: "USD",
  pieces: [
    {
      weight: "2.0",
      length: "10",
      width: "8",
      height: "4",
      insuranceAmount: "100.00",
      declaredValue: null,
    },
  ],
  billing: {
    party: "sender",
  },
  providerAccountId: null,
};

const multiRequestExample = {
  carrierCode: "fedex",
  serviceCode: "",
  packageTypeCode: "",
  sender: {
    country: "US",
    zip: "77001",
  },
  receiver: {
    city: "Salt Lake City",
    country: "US",
    zip: "84106",
    email: "foo@bar.com",
  },
  residential: true,
  signatureOptionCode: "DIRECT",
  contentDescription: "Test shipment – multiple services",
  weightUnit: "lb",
  dimUnit: "in",
  currency: "USD",
  customsCurrency: "USD",
  pieces: [
    {
      weight: "1.4",
      length: "5.1",
      width: "4",
      height: "2.5",
      insuranceAmount: "12.15",
      declaredValue: null,
    },
  ],
  billing: {
    party: "sender",
  },
  providerAccountId: null,
};

const api = new QuoteMockApi();

async function runTests() {
  console.log("\n" + "=".repeat(80));
  console.log("REQUEST vs RESPONSE - Quote Mock API");
  console.log("=".repeat(80) + "\n");

  console.log("┌─ TEST 1: Single-Service Quote (Fixture Match) ─────────────────────────┐\n");
  console.log("REQUEST:");
  console.log(JSON.stringify(singleRequestExample, null, 2));
  console.log("\nRESPONSE:");
  const single = await api.postSingleQuote(singleRequestExample);
  console.log(JSON.stringify(single, null, 2));
  console.log("\n" + "─".repeat(80) + "\n");

  console.log("┌─ TEST 2: Single-Service Quote (fedex_2day) ──────────────────────────────┐\n");
  const single2DayRequest = {
    ...singleRequestExample,
    serviceCode: "fedex_2day",
  };
  console.log("REQUEST:");
  console.log(JSON.stringify(single2DayRequest, null, 2));
  console.log("\nRESPONSE:");
  const single2Day = await api.postSingleQuote(single2DayRequest);
  console.log(JSON.stringify(single2Day, null, 2));
  console.log("\n" + "─".repeat(80) + "\n");

  console.log("┌─ TEST 3: Multi-Service Quote (Fixture Match) ───────────────────────────┐\n");
  console.log("REQUEST:");
  console.log(JSON.stringify(multiRequestExample, null, 2));
  console.log("\nRESPONSE:");
  const multi = await api.postMultiQuote(multiRequestExample);
  console.log(JSON.stringify(multi, null, 2));
  console.log("\n" + "=".repeat(80) + "\n");
}

runTests().catch(console.error);

