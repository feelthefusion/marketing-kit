-- Mobile fixture for the SQL self-test (runs after seed.sql): device context on the synthetic
-- journey, real-user vitals with known p75s, devices and installs for the mobile reports.
update crm_events set properties = properties || jsonb_build_object(
    'device', case when abs(hashtext(coalesce(anon_id, contact_id::text))) % 3 = 0 then 'desktop' else 'mobile' end,
    'os',     case when abs(hashtext(coalesce(anon_id, contact_id::text))) % 3 = 0 then 'macos'
                   when abs(hashtext(coalesce(anon_id, contact_id::text))) % 2 = 0 then 'ios' else 'android' end,
    'inapp',  case when abs(hashtext(coalesce(anon_id, contact_id::text))) % 5 = 0 then 'instagram' end)
where source = 'web';

-- vitals: mobile LCP 1800/2200/2600/3400 → p75 2800 (2 of 4 good); desktop 900/1100 → p75 1050 (all good)
insert into crm_events (name, source, anon_id, properties, occurred_at) values
 ('web.vital','web','v-m1','{"metric":"LCP","value":1800,"rating":"good","device":"mobile","path":"/"}', now()),
 ('web.vital','web','v-m2','{"metric":"LCP","value":2200,"rating":"good","device":"mobile","path":"/"}', now()),
 ('web.vital','web','v-m3','{"metric":"LCP","value":2600,"rating":"needs-improvement","device":"mobile","path":"/"}', now()),
 ('web.vital','web','v-m4','{"metric":"LCP","value":3400,"rating":"poor","device":"mobile","path":"/"}', now()),
 ('web.vital','web','v-d1','{"metric":"LCP","value":900,"rating":"good","device":"desktop","path":"/"}', now()),
 ('web.vital','web','v-d2','{"metric":"LCP","value":1100,"rating":"good","device":"desktop","path":"/"}', now()),
 ('web.vital','web','v-m1','{"metric":"INP","value":180,"rating":"good","device":"mobile","path":"/"}', now());

insert into crm_devices (install_id, platform, push_kind, push_token, push_status) values
 ('fx-ios-1','ios','expo','ExponentPushToken[fx1]','granted'),
 ('fx-and-1','android','expo',null,'denied'),
 ('fx-web-1','web','webpush','https://fcm.googleapis.com/fcm/send/fx','granted');
insert into crm_app_installs (install_id, source, partner_code, dedupe_key) values
 ('fx-ios-1','app_link','maya','fx-ios-1:app_link'),
 ('fx-and-1','install_referrer','maya','fx-and-1:install_referrer');
