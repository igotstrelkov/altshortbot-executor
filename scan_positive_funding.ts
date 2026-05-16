// scan_positive_funding.ts
async function main() {
  // scan_positive_funding.ts — find coins with positive funding (long bot candidates)
  const r = await fetch("https://api.bybit.com/v5/market/tickers?category=linear");
  const d = await r.json() as { result: { list: { symbol: string; fundingRate: string }[] } };
  const tickers = d.result.list.filter(t => t.symbol.endsWith("USDT"));
  
  const high: [string, number][] = [];
  const mid:  [string, number][] = [];
  
  for (const t of tickers) {
    const rate = parseFloat(t.fundingRate || "0");
    const apr  = rate * 3 * 365 * 100;
    const coin = t.symbol.replace("USDT", "");
    if (apr > 200) high.push([coin, apr]);
    else if (apr > 100) mid.push([coin, apr]);
  }
  
  high.sort((a, b) => b[1] - a[1]);
  mid.sort((a, b)  => b[1] - a[1]);
  
  console.log(`\n> +200% APR — ${high.length} strong long candidates:`);
  high.slice(0, 25).forEach(([c, a]) => console.log(`  ${c.padEnd(12)} ${a.toFixed(0)}%`));
  
  console.log(`\n+100–200% APR — ${mid.length} moderate candidates:`);
  mid.slice(0, 15).forEach(([c, a]) => console.log(`  ${c.padEnd(12)} ${a.toFixed(0)}%`));
  
  console.log(`\nTop 10 for backtest:`);
  console.log(high.slice(0, 10).map(([c]) => c).join(","));
  
}
main().catch(console.error);
