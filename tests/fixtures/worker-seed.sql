insert into crm_contacts (id,email) values ('00000000-0000-0000-0000-000000000001','a@x.co');
insert into crm_messages (idempotency_key, contact_id, channel, to_address, from_address, subject, body, provider, scheduled_for)
select 'e/'||g, '00000000-0000-0000-0000-000000000001', 'email', 'u'||g||'@x.co', 'Acme <hi@acme.co>', 'Hi', '<p>hi</p>', 'resend', now()
from generate_series(1,150) g;
insert into crm_messages (idempotency_key, contact_id, channel, to_address, from_address, body, provider, scheduled_for) values
 ('s/1','00000000-0000-0000-0000-000000000001','sms','+15550000001','+18885550100','hi','telnyx',now()),
 ('s/2','00000000-0000-0000-0000-000000000001','sms','+15550000300','+18885550100','hi','telnyx',now()),
 ('s/3','00000000-0000-0000-0000-000000000001','sms','+15550000002','+18885550100','hi','telnyx',now());
insert into crm_suppressions (channel,value,reason,source) values ('email','u7@x.co','hard_bounce','resend');
