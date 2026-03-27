import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DATE_FROM = "2026-03-26";
const DATE_TO = null;

const RAW_PAIRS = [
  ["MIZ498", "IB844"],
  ["MIZ501", "LP924"],
  ["MIZ503", "PT554"],
  ["MIZ512", "SM294"],
  ["MIZ513", "RO186"],
  ["MJS395", "RG021"],
  ["MJS396", "RG041"],
  ["MJS397", "RG043"],
  ["MJS401", "RG037"],
  ["MJS403", "RG019"],
  ["MJS407", "LP916"],
  ["MJS410", "TH955"],
  ["MJS412", "TH954"],
  ["MJS413", "RE558"],
  ["MJS418", "RE548"],
  ["MJU615", "NB499"],
  ["MJU618", "JV167"],
  ["MJU619", "RO194"],
  ["MJU625", "RG034"],
  ["MLG745", "LM387"],
  ["MMH622", "RG040"],
  ["MMH625", "RG039"],
  ["MMS735", "OB947"],
  ["MMS736", "SM305"],
  ["MMS738", "OP114"],
  ["MMS740", "MP604"],
  ["MMS742", "TH966"],
  ["MMS743", "PT538"],
  ["MMS744", "PT549"],
  ["MMS745", "SM320"],
  ["MOJ078", "OP113"],
  ["MOJ086", "TH965"],
  ["MOJ104", "LP917"],
  ["MOJ105", "RE556"],
  ["MOJ114", "MP611"],
  ["MOJ134", "RE534"],
  ["MOP751", "LP926"],
  ["MOP752", "PT548"],
  ["MOP762", "RO184"],
  ["MOP765", "RO182"],
  ["MPC479", "JV162"],
  ["MPC483", "TH962"],
  ["MPI428", "OB948"],
  ["MPI476", "ML231"],
  ["MPI478", "NB497"],
  ["MPS436", "SM316"],
  ["MPS438", "RO187"],
  ["MPS439", "OH220"],
  ["MPS445", "HI952"],
  ["MPS448", "PT553"],
  ["MPS460", "RO188"],
  ["MPS467", "LP914"],
  ["MPS949", "RO192"],
  ["MPS950", "MP606"],
  ["MPS952", "LM389"],
  ["MPS953", "NB498"],
  ["MPS954", "SM317"],
  ["MRA401", "RO197"],
  ["MRA402", "NB508"],
  ["MRA403", "NC275"],
  ["MYD148", "JV163"],
  ["MYD162", "NB495"],
  ["MYM986", "TH952"],
  ["MYM992", "SM297"],
  ["MYP018", "LP915"],
  ["MYP025", "OP132"],
  ["MYP033", "HI955"],
  ["MYP039", "RG042"],
  ["MYP045", "RG038"],
  ["NJC386", "OH209"],
  ["NJC402", "RE545"],
  ["NJC411", "LP930"],
  ["NJC418", "OS812"],
  ["NJC423", "LM388"],
  ["NJC424", "PT535"],
  ["NJC427", "MS239"],
  ["NJC428", "MS240"],
  ["NJC432", "HI954"],
  ["NJC436", "RE543"],
  ["NJC445", "IB847"],
  ["NJC458", "OH224"],
  ["NJC471", "RG022"],
  ["NJC477", "RE560"],
  ["NJC482", "RE553"],
  ["NJU805", "HI944"],
  ["NJU813", "RO180"],
  ["NJU823", "RE540"],
  ["NJU832", "RG045"],
  ["NJU849", "RE541"],
  ["NLR035", "JV171"],
  ["NLR039", "SM302"],
  ["NLR043", "SM318"],
  ["NLR045", "NB504"],
  ["NLR056", "PN686"],
  ["NLR057", "OH217"],
  ["NLR084", "RG036"],
  ["NLR085", "RE546"],
  ["NLR086", "HI951"],
  ["NLR089", "OH226"],
  ["NOE180", "HI948"],
  ["NOE192", "TH971"],
  ["NOE198", "OP133"],
  ["NOT114", "NC278"],
  ["NRE288", "NB506"],
  ["NRE289", "LP913"],
  ["NRE290", "PT556"],
  ["NRE291", "OH218"],
  ["NRE293", "NC274"],
  ["NRE294", "OH219"],
  ["NRE296", "PT546"],
  ["NRE299", "JV168"],
  ["NRK781", "RE535"],
  ["NRK782", "BY276"],
  ["NRL106", "RO190"],
  ["NRL580", '"RG023\t"'],
  ["NRL792", "GI719"],
  ["NRL801", "GI718"],
  ["NRL806", "BY272"],
  ["NRL809", "OB950"],
  ["NRL819", "SM298"],
  ["NRL824", "RG032"],
  ["NRL825", "GI720"],
  ["NRL826", "RG014"],
  ["NSF627", '"BY283\t"'],
  ["NSF628", "HI945"],
  ["NSF638", "MP602"],
  ["NSF648", '"BY282\t"'],
  ["NSF654", '"BY285\t"'],
  ["NSF662", '"BY281\t"'],
  ["NSF664", "SM299"],
  ["NSF671", "TH953"],
  ["NSF673", '"BY284\t"'],
  ["NSF677", "NC276"],
  ["NSL672", "PT547"],
];

function normalizePlate(value) {
  return String(value).replace(/["'\s\t]+/g, "").toUpperCase();
}

function parseToolText(result) {
  const txt = result?.content?.[0]?.text;
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function pickExactByNumber(arr, target) {
  const norm = normalizePlate(target);
  return (arr || []).find((x) => normalizePlate(x?.number ?? "") === norm) || null;
}

async function callTool(client, name, args) {
  return client.callTool({ name, arguments: args });
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/brunas-server.js"],
    cwd: process.cwd(),
  });

  const client = new Client({ name: "batch-link-mcp", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const failures = [];
  const successes = [];

  for (let i = 0; i < RAW_PAIRS.length; i += 1) {
    const [truckRaw, trailerRaw] = RAW_PAIRS[i];
    const truck = normalizePlate(truckRaw);
    const trailer = normalizePlate(trailerRaw);

    try {
      const vResRaw = await callTool(client, "search_vehicles", { query: truck });
      const vRes = parseToolText(vResRaw);
      const vehicles = Array.isArray(vRes?.data) ? vRes.data : [];
      const vehicle = pickExactByNumber(vehicles, truck) || (vehicles.length === 1 ? vehicles[0] : null);
      if (!vehicle) {
        failures.push({ truck, trailer, reason: "vehicle_not_found_or_ambiguous" });
        continue;
      }

      const tResRaw = await callTool(client, "find_trailers", {
        filters: [{ field: "number", value: [trailer], operator: "isAnyOfContains" }],
        page: 0,
        pageSize: 25,
      });
      const tRes = parseToolText(tResRaw);
      const trailers = Array.isArray(tRes?.data) ? tRes.data : [];
      const trailerObj = pickExactByNumber(trailers, trailer) || (trailers.length === 1 ? trailers[0] : null);
      if (!trailerObj) {
        failures.push({ truck, trailer, reason: "trailer_not_found_or_ambiguous" });
        continue;
      }

      const hResRaw = await callTool(client, "hook_trailer_to_vehicle", {
        vehicleId: Number(vehicle.id),
        trailerId: Number(trailerObj.id),
        dateFrom: DATE_FROM,
        dateTo: DATE_TO,
      });
      const hRes = parseToolText(hResRaw);
      if (hRes?.data?.status === 200) {
        successes.push({ truck, trailer, vehicleId: Number(vehicle.id), trailerId: Number(trailerObj.id) });
      } else {
        failures.push({ truck, trailer, reason: "create_failed" });
      }
    } catch (error) {
      failures.push({ truck, trailer, reason: `error:${error instanceof Error ? error.message : String(error)}` });
    }

    if ((i + 1) % 20 === 0) {
      console.log(`PROGRESS ${i + 1}/${RAW_PAIRS.length} success=${successes.length} fail=${failures.length}`);
    }
  }

  const report = {
    total: RAW_PAIRS.length,
    successful: successes.length,
    not_successful: failures.length,
    failures,
  };

  console.log("FINAL_REPORT");
  console.log(JSON.stringify(report, null, 2));

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
