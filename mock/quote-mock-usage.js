// quote-mock-usage.js
import { QuoteMockApi } from "./quote-mock-api.js";

// Example request bodies you can tweak or generate from ShipStation DOM.
const singleRequestExample = {
  carrierCode: "fedex",
  serviceCode: "fedex_standard_overnight",
  packageTypeCode: "fedex_custom_package",
  sender: {
    country: "US",
    zip: "77001",        // Houston
  },
  receiver: {
    city: "Los Angeles",
    country: "US",
    zip: "90001",
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
  serviceCode: "",       // empty → multi‑service
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

// Example: call from your extension dev console or content script
async function runMockTests() {
  console.log("=== Single-service mock ===");
  const single = await api.postSingleQuote(singleRequestExample);
  console.log(single);

  console.log("=== Multi-service mock ===");
  const multi = await api.postMultiQuote(multiRequestExample);
  console.log(multi);

  console.log("=== Generic quote() (auto single/multi) ===");
  const auto1 = await api.quote(singleRequestExample);
  const auto2 = await api.quote(multiRequestExample);
  console.log(auto1, auto2);
}

// For manual testing, you can call runMockTests() from the console.
window.runMockQuoteTests = runMockTests;
