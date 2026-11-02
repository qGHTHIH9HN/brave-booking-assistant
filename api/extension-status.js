// Safe deployment diagnostic. No database queries, secrets, or state changes.
export default function handler(req,res) {
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
 return res.status(200).json({
   service:'brave-booking-command-api',
   status:'preview-code-present',
   version:'0.2-preview',
   commandsEnabled: Boolean(process.env.EXTENSION_COMMAND_TOKEN && process.env.DATABASE_URL),
   note:'commandsEnabled means configured, not that the queue or browser connection has been tested'
 });
}
