<?php
/**
 * TM Horizon announce plugin for XAseco 1.x (TrackMania Forever dedicated servers).
 *
 * Every 5 minutes it tells the TM Horizon hub the server's name, players, slots and current map, so the
 * server shows up with live data in the launcher's server list. Opt-in: it does nothing until you put
 * the token you got after the hub approved your server into horizon_announce.xml.
 *
 * Install:
 *   1. Register the server on the website ("Add your server"), wait for the approval, get the token.
 *   2. Copy plugin.horizon_announce.php to xaseco/plugins/ and horizon_announce.xml to xaseco/.
 *   3. Put the token and the hub address into horizon_announce.xml.
 *   4. Add <plugin>plugin.horizon_announce.php</plugin> to xaseco/plugins.xml and restart XAseco.
 *
 * What is sent (JSON, HTTPS POST to <hub>/v1/servers/announce, header "Authorization: Bearer <token>"):
 *   name, players, maxPlayers, spectators, map, mode. Nothing else: no logins, no nicknames, no IP list.
 * The hub accepts one announcement per 4 minutes per server and ignores unknown tokens.
 *
 * Licence: AGPL-3.0-only, like the rest of TM Horizon.
 */

Aseco::registerEvent('onSync', 'horizon_announce_sync');
Aseco::registerEvent('onMainLoop', 'horizon_announce_tick');

global $horizon_announce;
$horizon_announce = array('url' => '', 'token' => '', 'interval' => 300, 'last' => 0, 'fails' => 0, 'next' => 0);

function horizon_announce_sync($aseco) {
	global $horizon_announce;
	$file = 'horizon_announce.xml';
	if (!file_exists($file)) {
		$aseco->console('[horizon_announce] ' . $file . ' not found, plugin is off');
		return;
	}
	$xml = $aseco->xml_parser->parseXml($file);
	$cfg = isset($xml['HORIZON_ANNOUNCE']) ? $xml['HORIZON_ANNOUNCE'] : array();
	$url = isset($cfg['HUB_URL'][0]) ? trim($cfg['HUB_URL'][0]) : '';
	$token = isset($cfg['TOKEN'][0]) ? trim($cfg['TOKEN'][0]) : '';
	if ($url === '' || !preg_match('/^tmhs_[A-Za-z0-9_-]{20,80}$/', $token)) {
		$aseco->console('[horizon_announce] no valid hub_url/token in ' . $file . ', plugin is off');
		return;
	}
	if (!preg_match('#^https://#i', $url)) {
		$aseco->console('[horizon_announce] hub_url must start with https://, plugin is off');
		return;
	}
	$horizon_announce['url'] = rtrim($url, '/') . '/v1/servers/announce';
	$horizon_announce['token'] = $token;
	$horizon_announce['next'] = time() + 20; // first announcement shortly after start
	$aseco->console('[horizon_announce] announcing to ' . $url . ' every 5 minutes');
}

function horizon_announce_tick($aseco) {
	global $horizon_announce;
	$h = &$horizon_announce;
	if ($h['token'] === '' || time() < $h['next']) return;
	// After a failure wait longer (5, 10, 20, ... up to 60 minutes) instead of hammering the hub.
	$h['next'] = time() + min(3600, $h['interval'] * (1 << min(4, $h['fails'])));

	$players = 0;
	$spectators = 0;
	$aseco->client->resetError();
	$list = $aseco->client->query('GetPlayerList', 300, 0);
	if (!$aseco->client->isError() && is_array($list)) {
		$res = $aseco->client->getResponse();
		foreach ((array) $res as $p) {
			if (isset($p['Login']) && $p['Login'] === $aseco->server->serverlogin) continue;
			$spec = isset($p['IsSpectator']) ? (bool) $p['IsSpectator'] : (isset($p['SpectatorStatus']) && ($p['SpectatorStatus'] % 10) != 0);
			if ($spec) $spectators++; else $players++;
		}
	} elseif (isset($aseco->server->players->player_list)) {
		$players = count($aseco->server->players->player_list);
	}

	$modes = array(0 => 'Rounds', 1 => 'TimeAttack', 2 => 'Team', 3 => 'Laps', 4 => 'Stunts', 5 => 'Cup');
	$mode = isset($aseco->server->gameinfo->mode) ? $aseco->server->gameinfo->mode : null;
	$body = json_encode(array(
		'name' => substr((string) $aseco->server->name, 0, 120),
		'players' => $players,
		'maxPlayers' => (int) $aseco->server->maxplayers,
		'spectators' => $spectators,
		'map' => isset($aseco->server->challenge->name) ? substr((string) $aseco->server->challenge->name, 0, 120) : null,
		'mode' => isset($modes[$mode]) ? $modes[$mode] : null,
		'version' => 'xaseco-horizon-1',
	));

	$ctx = stream_context_create(array('http' => array(
		'method' => 'POST',
		'header' => "Content-Type: application/json\r\nAuthorization: Bearer " . $h['token'] . "\r\n",
		'content' => $body,
		'timeout' => 4, // XAseco's main loop waits for this, keep it short
		'ignore_errors' => true,
	)));
	$reply = @file_get_contents($h['url'], false, $ctx);
	$code = 0;
	if (isset($http_response_header[0]) && preg_match('#\s(\d{3})\s#', $http_response_header[0], $m)) $code = (int) $m[1];
	if ($reply !== false && $code == 200) {
		$h['fails'] = 0;
		$h['next'] = time() + $h['interval'];
	} elseif ($code == 429) {
		$h['next'] = time() + $h['interval']; // announced a moment ago (restart): try again at the normal pace
	} else {
		$h['fails']++;
		$aseco->console('[horizon_announce] announce failed (HTTP ' . $code . '), next try in ' . ($h['next'] - time()) . ' s');
	}
}
