-- The assistant goes by OVOA. Only rename accounts still on an old default name.
UPDATE settings SET assistant_name = 'OVOA' WHERE assistant_name IN ('Assistant', 'Jarvis');
