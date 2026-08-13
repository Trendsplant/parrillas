import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "200kb" }));
let strategy = { enabled:true, mode:"simulation", collectionHandle:"men", fallback:"original", weights:{temperatureFit:30,countryAffinity:20,recentSales:20,newness:15,availability:15}, exclusions:{excludeOutOfStock:true,preserveManualProducts:true}, audit:{lastUpdated:null,lastApplied:null,lastAppliedBy:null} };
function normalizeWeights(weights={}) {
  const keys=["temperatureFit","countryAffinity","recentSales","newness","availability"];
  const values=Object.fromEntries(keys.map(k=>[k,Math.max(0,Number(weights[k]||0))]));
  const total=Object.values(values).reduce((a,b)=>a+b,0)||1;
  return Object.fromEntries(keys.map(k=>[k,Math.round(values[k]/total*100)]));
}
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"trendsplant-ordering-app"}));
app.get("/api/strategy",(_req,res)=>res.json(strategy));
app.put("/api/strategy",(req,res)=>{strategy={...strategy,...req.body,weights:normalizeWeights(req.body?.weights||strategy.weights),audit:{...strategy.audit,lastUpdated:new Date().toISOString()}};res.json(strategy);});
app.post("/api/strategy/simulate",(req,res)=>{const context={country:req.body?.country||"ES",temperatureC:Number(req.body?.temperatureC??22),collectionHandle:strategy.collectionHandle};const sample=[["Essential T-Shirt","light",78],["Hooded Oversized Sweatshirt","warm",72],["Easy Denim Pants","mid",75],["Timber Corduroy Cap","accessory",68]];const ranked=sample.map(([title,type,baseScore],i)=>({id:"sample-"+(i+1),title,type,score:Math.min(100,baseScore+Math.round((((context.temperatureC>=25&&type==="light")||(context.temperatureC<=14&&type==="warm")?22:type==="mid"?8:0)*strategy.weights.temperatureFit/100)))})).sort((a,b)=>b.score-a.score);res.json({context,ranked,strategyVersion:strategy.audit.lastUpdated});});
app.post("/api/strategy/apply",(_req,res)=>{if(strategy.mode!=="live")return res.status(409).json({error:"La estrategia está en modo simulación. Cambia a live antes de aplicar."});strategy.audit={...strategy.audit,lastApplied:new Date().toISOString(),lastAppliedBy:"admin"};res.json({ok:true,message:"Aplicación preparada para el conector Shopify.",strategy});});
app.get("/auth/shopify",(req,res)=>{const shop=String(req.query.shop||"").replace(/\.myshopify\.com$/,"");if(!shop||!process.env.SHOPIFY_API_KEY||!process.env.SHOPIFY_APP_URL)return res.status(400).send("Faltan variables de Shopify.");const state=crypto.randomBytes(16).toString("hex");const scopes=encodeURIComponent(process.env.SHOPIFY_SCOPES||"read_products,write_products,read_inventory");const redirect=encodeURIComponent(process.env.SHOPIFY_APP_URL+"/auth/callback");res.redirect(`https://${shop}.myshopify.com/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${redirect}&state=${state}`);});
app.get("/auth/callback",(_req,res)=>res.status(501).send("OAuth callback pendiente."));
export default app;
