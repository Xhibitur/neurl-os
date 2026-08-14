// netlify/functions/send-reminders.js
// Scheduled function: runs every Sunday at 6pm UTC
// Sends Web Push notifications to subscribed users

exports.handler = async (event) => {
  try {
    const privateKey = process.env.PUSH_PRIVATE_KEY;
    
    if (!privateKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'PUSH_PRIVATE_KEY not set in Netlify environment' })
      };
    }
    
    console.log('Reminder job triggered at', new Date().toISOString());
    
    // Current: this is a placeholder that just logs and succeeds
    // When you're ready to send real notifications, add Supabase:
    // 
    // 1. Create a table in Supabase to store push subscriptions
    // 2. Query the table for users who haven't calibrated in 7 days
    // 3. Send a notification to each using the web-push library
    //
    // Example with Supabase:
    // 
    // const { createClient } = require('@supabase/supabase-js');
    // const webpush = require('web-push');
    // 
    // webpush.setVapidDetails(
    //   'mailto:you@neurl-os.com',
    //   process.env.PUSH_PUBLIC_KEY,
    //   privateKey
    // );
    // 
    // const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    // const { data: subs } = await supabase.from('push_subscriptions').select('*');
    // 
    // for (const sub of subs) {
    //   try {
    //     await webpush.sendNotification(JSON.parse(sub.subscription), JSON.stringify({
    //       title: 'Time for your NEURL Score',
    //       body: 'See what changed this week.',
    //       url: 'https://neurl-os.com'
    //     }));
    //   } catch (err) {
    //     if (err.statusCode === 410) await supabase.from('push_subscriptions').delete().eq('id', sub.id);
    //   }
    // }
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Reminder job ran',
        timestamp: new Date().toISOString()
      })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
