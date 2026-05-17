import { RestClientV5 } from 'bybit-api';

async function main() {
  const c = new RestClientV5({ 
    key: process.env.BYBIT_API_KEY ?? "", 
    secret: process.env.BYBIT_API_SECRET ?? "", 
    testnet: false 
  });
  
  for (const accountType of ['UNIFIED', 'CONTRACT'] as const) {
    const r = await c.getWalletBalance({ accountType });
    console.log(`\n${accountType}:`);
    console.log(JSON.stringify(r.result?.list?.[0], null, 2));
  }
}

main().catch(console.error);
