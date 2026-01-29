// quote-mock-api.js
import { MOCK_SINGLE_QUOTES, MOCK_MULTI_QUOTES } from "./quote-mock-data.js";

/**
 * Helper to safely get first piece weight as string.
 */
function getWeight(req) {
  const pieces = req.pieces || [];
  if (!pieces.length) return "0";
  return String(pieces[0].weight || "0");
}

/**
 * Build key for single‑service fixtures.
 */
function buildSingleKey(req) {
  const carrier = req.carrierCode || "fedex";
  const service = req.serviceCode || "";
  const originZip = req.sender?.zip || "";
  const destZip = req.receiver?.zip || "";
  const weight = getWeight(req);
  return `${carrier}|${service}|${originZip}|${destZip}|${weight}`;
}

/**
 * Build key for multi‑service fixtures.
 */
function buildMultiKey(req) {
  const carrier = req.carrierCode || "fedex";
  const originZip = req.sender?.zip || "";
  const destZip = req.receiver?.zip || "";
  const weight = getWeight(req);
  return `${carrier}|${originZip}|${destZip}|${weight}`;
}

/**
 * Mock API class: call these methods instead of fetch()
 * while you develop the extension.
 */
export class QuoteMockApi {
  /**
   * Simulates POST /restapi/v1/customers/:customerId/quote
   * when serviceCode is provided.
   *
   * @param {object} requestBody same shape as real Quote request
   * @returns {Promise<object>} single‑service response JSON
   */
  async postSingleQuote(requestBody) {
    const key = buildSingleKey(requestBody);
    const match = MOCK_SINGLE_QUOTES[key];

    // Simulate async latency
    await new Promise((r) => setTimeout(r, 150));

    if (match) {
      return JSON.parse(JSON.stringify(match)); // deep copy
    }

    // Default fallback when no fixture found
    const weight = parseFloat(getWeight(requestBody) || "0") || 0;
    const base = (weight * 10 || 10).toFixed(2);

    return {
      carrierCode: requestBody.carrierCode || "fedex",
      serviceCode: requestBody.serviceCode || "fedex_standard_overnight",
      packageTypeCode: requestBody.packageTypeCode || "fedex_custom_package",
      currency: requestBody.currency || "USD",
      customsCurrency: requestBody.customsCurrency || "USD",
      totalAmount: base,
      baseAmount: base,
      surcharges: [],
      zone: "2",
      quotedWeight: String(Math.max(1, Math.round(weight))),
      quotedWeightType: "Actual",
    };
  }

  /**
   * Simulates POST /quote for multiple services
   * when serviceCode/packageTypeCode are empty.
   *
   * @param {object} requestBody
   * @returns {Promise<object>} multi‑service response JSON { quotes: [...] }
   */
  async postMultiQuote(requestBody) {
    const key = buildMultiKey(requestBody);
    const match = MOCK_MULTI_QUOTES[key];

    await new Promise((r) => setTimeout(r, 150));

    if (match) {
      return JSON.parse(JSON.stringify(match));
    }

    // Default: synthesize two services from single quote
    const baseSingle = await this.postSingleQuote({
      ...requestBody,
      serviceCode: requestBody.serviceCode || "fedex_standard_overnight",
    });

    const baseAmount = parseFloat(baseSingle.baseAmount || "0") || 0;
    const totalAmount = parseFloat(baseSingle.totalAmount || "0") || 0;

    return {
      quotes: [
        {
          ...baseSingle,
          serviceDescription: "FedEx Standard Overnight",
        },
        {
          ...baseSingle,
          serviceCode: "fedex_2day",
          serviceDescription: "FedEx 2Day",
          totalAmount: (totalAmount * 0.7).toFixed(2),
          baseAmount: (baseAmount * 0.7).toFixed(2),
          zone: "4",
        },
      ],
    };
  }

  /**
   * Convenience: choose single vs multi based on serviceCode presence.
   */
  async quote(requestBody) {
    if (requestBody.serviceCode && requestBody.serviceCode.trim() !== "") {
      return this.postSingleQuote(requestBody);
    }
    return this.postMultiQuote(requestBody);
  }
}
