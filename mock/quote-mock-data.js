// quote-mock-data.js
// Static in-memory JSON fixtures used by the mock API.

/**
 * Single‑service response (similar to docs example)
 */
export const MOCK_SINGLE_QUOTES = {
  // key: `${carrierCode}|${serviceCode}|${originZip}|${destZip}|${weight}`
  "fedex|fedex_standard_overnight|77001|90001|2.0": {
    carrierCode: "fedex",
    serviceCode: "fedex_standard_overnight",
    packageTypeCode: "fedex_custom_package",
    currency: "USD",
    customsCurrency: "USD",
    totalAmount: "27.50",
    baseAmount: "25.00",
    surcharges: [
      {
        description: "Residential surcharge",
        amount: "2.50",
      },
    ],
    zone: "2",
    quotedWeight: "2",
    quotedWeightType: "Actual",
  },

  "fedex|fedex_2day|77001|90001|2.0": {
    carrierCode: "fedex",
    serviceCode: "fedex_2day",
    packageTypeCode: "fedex_custom_package",
    currency: "USD",
    customsCurrency: "USD",
    totalAmount: "19.00",
    baseAmount: "17.00",
    surcharges: [
      {
        description: "Residential surcharge",
        amount: "2.00",
      },
    ],
    zone: "4",
    quotedWeight: "2",
    quotedWeightType: "Actual",
  },
};

/**
 * Multi‑service response fixtures keyed by
 * `${carrierCode}|${originZip}|${destZip}|${weight}`
 */
export const MOCK_MULTI_QUOTES = {
  "fedex|77001|84106|1.4": {
    quotes: [
      {
        carrierCode: "fedex",
        serviceCode: "fedex_ground",
        serviceDescription: "FedEx Ground",
        packageTypeCode: "fedex_custom_package",
        currency: "USD",
        customsCurrency: "USD",
        totalAmount: "16.27",
        baseAmount: "12.15",
        surcharges: [
          {
            description: "Residential surcharge",
            amount: "4.12",
          },
        ],
        zone: "2",
        quotedWeight: "2",
        quotedWeightType: "Actual",
      },
      {
        carrierCode: "fedex",
        serviceCode: "fedex_2day",
        serviceDescription: "FedEx 2Day",
        packageTypeCode: "fedex_custom_package",
        currency: "USD",
        customsCurrency: "USD",
        totalAmount: "41.72",
        baseAmount: "22.66",
        surcharges: [
          {
            description: "ResidentialExpress",
            amount: "5.15",
          },
        ],
        zone: "202",
        quotedWeight: "2",
        quotedWeightType: "Actual",
      },
    ],
  },
};
