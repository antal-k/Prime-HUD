#!/usr/bin/env python3
"""Convert a CS2 demo into the Game State Integration frames CS2 would POST to /cs2/input.

usage: demo2gsi.py DEMO OUT.jsonl [--rounds 4,6,13-14] [--step 4]

setup: python3 -m venv .worktrees/venv && .worktrees/venv/bin/pip install demoparser2 pandas

Each output line is {"tick", "round", "gsi"} with raw CS2 values (observer_slot 0-9).
OUT.meta.json lists rounds, kills and bomb events so a replayer can pick moments.
Not in the demo, so approximated: inferno flame positions, the observed player,
ammo of holstered weapons, and grenade counts (one of each type).
"""
import argparse
import json
import math
import random
from collections import defaultdict

import pandas as pd
from demoparser2 import DemoParser

TICKRATE = 64
BOMB_TIMER = 40
SMOKE_RADIUS = 144

WEAPONS = {
    1: ("deagle", "Pistol", 7), 2: ("elite", "Pistol", 30), 3: ("fiveseven", "Pistol", 20),
    4: ("glock", "Pistol", 20), 7: ("ak47", "Rifle", 30), 8: ("aug", "Rifle", 30),
    9: ("awp", "SniperRifle", 5), 10: ("famas", "Rifle", 25), 11: ("g3sg1", "SniperRifle", 20),
    13: ("galilar", "Rifle", 35), 14: ("m249", "Machine Gun", 100), 16: ("m4a1", "Rifle", 30),
    17: ("mac10", "Submachine Gun", 30), 19: ("p90", "Submachine Gun", 50),
    23: ("mp5sd", "Submachine Gun", 30), 24: ("ump45", "Submachine Gun", 25),
    25: ("xm1014", "Shotgun", 7), 26: ("bizon", "Submachine Gun", 64), 27: ("mag7", "Shotgun", 5),
    28: ("negev", "Machine Gun", 150), 29: ("sawedoff", "Shotgun", 7), 30: ("tec9", "Pistol", 18),
    31: ("taser", None, 1), 32: ("hkp2000", "Pistol", 13), 33: ("mp7", "Submachine Gun", 30),
    34: ("mp9", "Submachine Gun", 30), 35: ("nova", "Shotgun", 8), 36: ("p250", "Pistol", 13),
    38: ("scar20", "SniperRifle", 20), 39: ("sg556", "Rifle", 30), 40: ("ssg08", "SniperRifle", 10),
    42: ("knife", "Knife", None), 43: ("flashbang", "Grenade", None), 44: ("hegrenade", "Grenade", None),
    45: ("smokegrenade", "Grenade", None), 46: ("molotov", "Grenade", None), 47: ("decoy", "Grenade", None),
    48: ("incgrenade", "Grenade", None), 49: ("c4", "C4", None), 59: ("knife_t", "Knife", None),
    60: ("m4a1_silencer", "Rifle", 20), 61: ("usp_silencer", "Pistol", 12), 63: ("cz75a", "Pistol", 12),
    64: ("revolver", "Pistol", 8),
}
KNIVES = {
    500: "bayonet", 503: "knife_css", 505: "knife_flip", 506: "knife_gut", 507: "knife_karambit",
    508: "knife_m9_bayonet", 509: "knife_tactical", 512: "knife_falchion", 514: "knife_survival_bowie",
    515: "knife_butterfly", 516: "knife_push", 517: "knife_cord", 518: "knife_canis", 519: "knife_ursus",
    520: "knife_gypsy_jackknife", 521: "knife_outdoor", 522: "knife_stiletto", 523: "knife_widowmaker",
    525: "knife_skeleton", 526: "knife_kukri",
}
PROJECTILES = {
    "CSmokeGrenadeProjectile": "smoke", "CHEGrenadeProjectile": "frag", "CFlashbangProjectile": "flashbang",
    "CMolotovProjectile": "firebomb", "CDecoyProjectile": "decoy",
}
WIN_REASONS = {
    "t_killed": "ct_win_elimination", "ct_killed": "t_win_elimination", "bomb_defused": "ct_win_defuse",
    "bomb_exploded": "t_win_bomb", "time_ran_out": "ct_win_time",
}
EVENTS = [
    "round_start", "round_freeze_end", "round_end", "player_death", "player_hurt", "player_blind",
    "bomb_beginplant", "bomb_abortplant", "bomb_planted", "bomb_begindefuse", "bomb_abortdefuse",
    "bomb_defused", "bomb_exploded", "bomb_dropped", "smokegrenade_detonate", "inferno_startburn",
    "inferno_expire",
]
PLAYER_PROPS = [
    "X", "Y", "Z", "yaw", "pitch", "health", "armor_value", "has_helmet", "has_defuser", "balance",
    "current_equip_value", "inventory", "inventory_as_ids", "active_weapon_name", "active_weapon_ammo",
    "total_ammo_left", "team_num", "team_clan_name", "mvps", "score", "is_defusing", "flash_duration",
]
RULES_PROPS = [
    "is_ct_timeout", "is_terrorist_timeout", "is_technical_timeout", "is_waiting_for_resume",
    "is_game_paused", "ct_time_out_remaining", "terrorist_time_out_remaining",
]
# demoparser2 has no friendly names for these and silently drops unknown ones.
RULES_RAW = {
    "CCSGameRulesProxy.CCSGameRules.m_nCTTimeOuts": "ct_timeouts",
    "CCSGameRulesProxy.CCSGameRules.m_nTerroristTimeOuts": "terrorist_timeouts",
    "CCSGameRulesProxy.CCSGameRules.m_iRoundTime": "round_time",
}


def sid(value):
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    text = str(value)
    return None if text in ("", "0", "nan", "None") else text


def num(value, default=0):
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return default
    return value


def vec(x, y, z):
    return f"{x:.2f}, {y:.2f}, {z:.2f}"


def weapon_info(def_index):
    if def_index in WEAPONS:
        return WEAPONS[def_index]
    if def_index in KNIVES:
        return KNIVES[def_index], "Knife", None
    return "knife", "Knife", None


def parse_round_list(spec, total):
    if not spec:
        return set(range(1, total + 1))
    wanted = set()
    for part in spec.split(","):
        lo, _, hi = part.partition("-")
        wanted.update(range(int(lo), int(hi or lo) + 1))
    return wanted


def load_events(parser):
    # round_start/round_end are synthesized by demoparser2, so list_game_events() can't be used as a filter.
    events = {name: pd.DataFrame(columns=["tick"]) for name in EVENTS}
    events.update(dict(parser.parse_events(EVENTS)))
    return events


def build_rounds(events):
    starts = sorted(events["round_start"]["tick"])
    freezes = sorted(events["round_freeze_end"]["tick"])
    rounds = []
    for row in events["round_end"].sort_values("tick").itertuples():
        start = max((t for t in starts if t < row.tick), default=0)
        freeze = max((t for t in freezes if start <= t < row.tick), default=start)
        winner = {2: "T", 3: "CT"}.get(row.winner, row.winner)
        rounds.append({"num": len(rounds) + 1, "start": int(start), "freeze_end": int(freeze),
                       "end": int(row.tick), "winner": winner, "reason": row.reason})
    for cur, nxt in zip(rounds, rounds[1:]):
        cur["next_start"] = nxt["start"]
    rounds[-1]["next_start"] = rounds[-1]["end"] + 12 * TICKRATE
    return rounds


def grenade_instances(parser, wanted_ticks, detonations):
    """Projectiles at the sampled ticks, keyed by tick, with lifetime and smoke effect time."""
    g = parser.parse_grenades()
    g = g[g["grenade_type"].isin(PROJECTILES.keys()) & g["x"].notna()]
    g = g.sort_values(["grenade_entity_id", "tick"]).reset_index(drop=True)
    new = ((g["grenade_entity_id"].diff() != 0) | (g["tick"].diff() > 8)
           | (g["grenade_type"] != g["grenade_type"].shift()))
    g["inst"] = new.cumsum()
    g["born"] = g.groupby("inst")["tick"].transform("min")
    g["died"] = g.groupby("inst")["tick"].transform("max")
    by_tick = defaultdict(list)
    for row in g[g["tick"].isin(wanted_ticks)].itertuples():
        kind = PROJECTILES[row.grenade_type]
        detonated = None
        if kind == "smoke":
            detonated = next((t for t in detonations.get(row.grenade_entity_id, ())
                              if row.born <= t <= row.died), None)
        by_tick[row.tick].append({
            "id": f"{row.grenade_entity_id}", "type": kind, "owner": sid(row.steamid),
            "pos": (row.x, row.y, row.z), "born": row.born, "detonated": detonated,
        })
    return by_tick


def inferno_list(events):
    expires = defaultdict(list)
    for row in events["inferno_expire"].itertuples():
        expires[row.entityid].append(row.tick)
    out = []
    for row in events["inferno_startburn"].itertuples():
        end = min((t for t in expires[row.entityid] if t > row.tick), default=row.tick + 7 * TICKRATE)
        out.append({"id": row.entityid, "owner": sid(row.user_steamid), "start": row.tick, "end": end,
                    "pos": (row.x, row.y, row.z)})
    return out


def flames(inferno, tick):
    age = (tick - inferno["start"]) / TICKRATE
    radius = 50 + min(age, 2.0) / 2.0 * 100
    rnd = random.Random(inferno["id"] * 7919 + inferno["start"])
    x, y, z = inferno["pos"]
    out = {}
    for i in range(14):
        angle = rnd.random() * 2 * math.pi
        dist = math.sqrt(rnd.random()) * radius
        out[f"flame_{inferno['id']}_{i}"] = vec(x + dist * math.cos(angle), y + dist * math.sin(angle), z)
    return out


class Match:
    """Running state fed by game events in tick order; turned into GSI at each sampled tick."""

    def __init__(self, rounds, slots, team_names, side_by_round):
        self.rounds = rounds
        self.slots = slots
        self.team_names = team_names
        self.side_by_round = side_by_round
        self.side_of = {}
        self.kills = defaultdict(int)
        self.deaths = defaultdict(int)
        self.assists = defaultdict(int)
        self.round_kills = defaultdict(int)
        self.round_killhs = defaultdict(int)
        self.round_dmg = defaultdict(int)
        self.victim_hp = defaultdict(lambda: 100)
        self.blind = {}
        self.flash_seen = {}
        self.defuse_starts = []
        self.burn = {}
        self.wins = defaultdict(int)
        self.losses = defaultdict(int)
        self.round_wins = {}
        self.rounds_done = 0
        self.observed = None
        self.positions = {}
        self.teams = {}
        self.ammo = {}
        self.reset_bomb()

    def reset_bomb(self):
        self.bomb = {"planting": None, "planted": None, "defusing": None, "defused": None,
                     "exploded": None, "dropped_at": None}

    def team_key(self, steamid):
        return self.team_names.get(steamid)

    def on_event(self, name, row, tick):
        b = self.bomb
        if name == "round_start":
            self.round_kills.clear()
            self.round_killhs.clear()
            self.round_dmg.clear()
            self.victim_hp.clear()
            self.reset_bomb()
        elif name == "round_end":
            r = self.rounds[self.rounds_done]
            side_team = {"CT" if num == 3 else "T": key for key, num in self.side_by_round[r["num"]].items()}
            winner = side_team.get(r["winner"])
            for key in side_team.values():
                if key == winner:
                    self.wins[key] += 1
                    self.losses[key] = 0
                else:
                    self.losses[key] += 1
            reason = WIN_REASONS.get(r["reason"], f"{r['winner'].lower()}_win_elimination")
            self.round_wins[str(r["num"])] = reason
            self.rounds_done += 1
        elif name == "player_death":
            victim, attacker, assister = sid(row.user_steamid), sid(row.attacker_steamid), sid(row.assister_steamid)
            self.deaths[victim] += 1
            if attacker and attacker != victim and attacker in self.teams:
                if self.teams[attacker] != self.teams.get(victim):
                    self.kills[attacker] += 1
                    self.round_kills[attacker] += 1
                    if row.headshot:
                        self.round_killhs[attacker] += 1
                else:
                    self.kills[attacker] -= 1
                self.observed = attacker
            if assister and self.teams.get(assister) != self.teams.get(victim):
                self.assists[assister] += 1
        elif name == "player_hurt":
            victim, attacker = sid(row.user_steamid), sid(row.attacker_steamid)
            dealt = max(0, self.victim_hp[victim] - int(row.health))
            self.victim_hp[victim] = int(row.health)
            if attacker and attacker != victim and self.teams.get(attacker) != self.teams.get(victim):
                self.round_dmg[attacker] += dealt
            if row.weapon in ("inferno", "molotov", "incgrenade"):
                self.burn[victim] = tick
        elif name == "player_blind":
            duration = float(num(getattr(row, "blind_duration", 0)))
            if duration > 0:
                self.blind[sid(row.user_steamid)] = (tick, duration)
        elif name == "bomb_beginplant":
            b["planting"] = sid(row.user_steamid)
            self.observed = b["planting"]
        elif name == "bomb_abortplant":
            b["planting"] = None
        elif name == "bomb_planted":
            planter = sid(row.user_steamid)
            b["planting"] = None
            b["planted"] = (tick, self.positions.get(planter, (0, 0, 0)))
        elif name == "bomb_begindefuse":
            defuser = sid(row.user_steamid)
            b["defusing"] = (defuser, tick, 5 if getattr(row, "haskit", False) else 10)
            self.observed = defuser
        elif name == "bomb_abortdefuse":
            b["defusing"] = None
        elif name == "bomb_defused":
            b["defusing"] = None
            b["defused"] = tick
        elif name == "bomb_exploded":
            b["exploded"] = tick
        elif name == "bomb_dropped":
            b["dropped_at"] = self.positions.get(sid(row.user_steamid))

    def frame(self, tick, round_index, rows, grenades, infernos, header):
        r = self.rounds[round_index]
        rule = lambda name, default=0: num(getattr(rows[0], name, default), default)
        allplayers, carrier, alive, defusing_now = {}, None, set(), set()
        for row in rows:
            steamid = sid(row.steamid)
            team = "CT" if row.team_num == 3 else "T"
            self.teams[steamid] = team
            pos = (float(num(row.X)), float(num(row.Y)), float(num(row.Z)))
            self.positions[steamid] = pos
            health = int(num(row.health))
            ids = list(row.inventory_as_ids) if isinstance(row.inventory_as_ids, (list, tuple)) else []
            names = list(row.inventory) if isinstance(row.inventory, (list, tuple)) else []
            if health > 0:
                alive.add(steamid)
                if 49 in ids:
                    carrier = steamid
            active = next((i for n, i in zip(names, ids) if n == row.active_weapon_name), None)
            weapons, by_index = {}, {}
            if health > 0:
                for def_index in ids:
                    if def_index in by_index and weapon_info(def_index)[1] == "Grenade":
                        by_index[def_index]["ammo_reserve"] += 1
                        continue
                    cls, kind, clip_max = weapon_info(def_index)
                    w = {"name": f"weapon_{cls}", "paintkit": "default"}
                    if kind:
                        w["type"] = kind
                    if clip_max:
                        if def_index == active and not pd.isna(row.active_weapon_ammo):
                            self.ammo[(steamid, def_index)] = (int(row.active_weapon_ammo), int(num(row.total_ammo_left)))
                        clip, reserve = self.ammo.get((steamid, def_index), (clip_max, clip_max * 3))
                        w.update(ammo_clip=clip, ammo_clip_max=clip_max, ammo_reserve=reserve)
                    elif kind == "Grenade":
                        w["ammo_reserve"] = 1
                    w["state"] = "active" if def_index == active else "holstered"
                    by_index[def_index] = w
                    weapons[f"weapon_{len(weapons)}"] = w
            flash_duration = float(num(row.flash_duration))
            if flash_duration > 0 and self.flash_seen.get(steamid) != flash_duration:
                self.blind[steamid] = (tick, flash_duration)
            self.flash_seen[steamid] = flash_duration
            if health > 0 and num(row.is_defusing, False):
                defusing_now.add(steamid)
                if not self.bomb["defusing"]:
                    self.bomb["defusing"] = (steamid, tick, 5 if num(row.has_defuser, False) else 10)
                    self.defuse_starts.append({"tick": tick, "player": row.name})
                    self.observed = steamid
            yaw, pitch = math.radians(float(num(row.yaw))), math.radians(float(num(row.pitch)))
            forward = (math.cos(pitch) * math.cos(yaw), math.cos(pitch) * math.sin(yaw), -math.sin(pitch))
            flashed = 0
            if steamid in self.blind:
                start, duration = self.blind[steamid]
                left = 1 - (tick - start) / TICKRATE / duration
                flashed = int(255 * max(0.0, min(1.0, left)))
            burning = 0
            if steamid in self.burn:
                burning = int(255 * max(0.0, 1 - (tick - self.burn[steamid]) / TICKRATE))
            state = {
                "health": health, "armor": int(num(row.armor_value)) if health else 0,
                "helmet": bool(num(row.has_helmet, False)) and health > 0, "flashed": flashed,
                "smoked": 0, "burning": burning, "money": int(num(row.balance)),
                "round_kills": self.round_kills[steamid], "round_killhs": self.round_killhs[steamid],
                "round_totaldmg": self.round_dmg[steamid], "equip_value": int(num(row.current_equip_value)),
            }
            if team == "CT" and health > 0 and num(row.has_defuser, False):
                state["defusekit"] = True
            allplayers[steamid] = {
                "name": row.name, "observer_slot": self.slots[steamid], "team": team, "state": state,
                "match_stats": {"kills": self.kills[steamid], "assists": self.assists[steamid],
                                "deaths": self.deaths[steamid], "mvps": int(num(row.mvps)),
                                "score": int(num(row.score))},
                "weapons": weapons, "position": vec(*pos), "forward": vec(*forward),
            }
        allplayers = dict(sorted(allplayers.items(), key=lambda kv: kv[1]["observer_slot"]))
        if self.bomb["defusing"] and self.bomb["defusing"][0] not in defusing_now and not self.bomb["defused"]:
            self.bomb["defusing"] = None
        self.side_of = {self.team_key(s): p["team"] for s, p in allplayers.items()}

        gsi_grenades, smokes = {}, []
        for g in grenades:
            lifetime = (tick - g["born"]) / TICKRATE
            entry = {"owner": g["owner"], "position": vec(*g["pos"]), "velocity": "0.00, 0.00, 0.00",
                     "lifetime": f"{lifetime:.1f}", "type": g["type"]}
            if g["type"] == "smoke":
                effect = (tick - g["detonated"]) / TICKRATE if g["detonated"] else 0
                entry["effecttime"] = f"{effect:.1f}"
                if effect > 0.5:
                    smokes.append(g["pos"])
            gsi_grenades[g["id"]] = entry
        for inf in infernos:
            if inf["start"] <= tick < inf["end"]:
                gsi_grenades[f"{inf['id'] + 100000}"] = {
                    "owner": inf["owner"], "lifetime": f"{(tick - inf['start']) / TICKRATE:.1f}",
                    "type": "inferno", "flames": flames(inf, tick)}
        for steamid in alive:
            x, y, z = self.positions[steamid]
            if any(math.dist((x, y), s[:2]) < SMOKE_RADIUS and abs(z - s[2]) < 130 for s in smokes):
                allplayers[steamid]["state"]["smoked"] = 255

        bomb, b = None, self.bomb
        if b["exploded"]:
            bomb = {"state": "exploded", "position": vec(*b["planted"][1]) if b["planted"] else "0, 0, 0"}
        elif b["defused"]:
            bomb = {"state": "defused", "position": vec(*b["planted"][1])}
        elif b["defusing"] and b["planted"]:
            defuser, started, needed = b["defusing"]
            left = max(0.0, needed - (tick - started) / TICKRATE)
            bomb = {"state": "defusing", "position": vec(*b["planted"][1]), "player": defuser,
                    "countdown": f"{left:.1f}"}
        elif b["planted"]:
            left = max(0.0, BOMB_TIMER - (tick - b["planted"][0]) / TICKRATE)
            bomb = {"state": "planted", "position": vec(*b["planted"][1]), "countdown": f"{left:.1f}"}
        elif b["planting"] in alive:
            bomb = {"state": "planting", "position": vec(*self.positions[b["planting"]]), "player": b["planting"]}
        elif carrier:
            bomb = {"state": "carried", "position": vec(*self.positions[carrier]), "player": carrier}
        elif b["dropped_at"]:
            bomb = {"state": "dropped", "position": vec(*b["dropped_at"])}

        round_time = float(rule("round_time", 115)) or 115
        paused = bool(rule("is_technical_timeout", False) or rule("is_game_paused", False))
        round_info = {}
        if tick < r["freeze_end"]:
            round_info["phase"] = "freezetime"
            if rule("is_ct_timeout", False):
                countdown = ("timeout_ct", float(rule("ct_time_out_remaining")))
            elif rule("is_terrorist_timeout", False):
                countdown = ("timeout_t", float(rule("terrorist_time_out_remaining")))
            elif paused or rule("is_waiting_for_resume", False):
                countdown = ("paused", 0.0)
            else:
                countdown = ("freezetime", (r["freeze_end"] - tick) / TICKRATE)
        elif tick < r["end"]:
            round_info["phase"] = "live"
            if paused:
                countdown = ("paused", 0.0)
            elif bomb and bomb["state"] == "defusing":
                countdown = ("defuse", float(bomb["countdown"]))
            elif b["planted"]:
                countdown = ("bomb", BOMB_TIMER - (tick - b["planted"][0]) / TICKRATE)
            else:
                countdown = ("live", round_time - (tick - r["freeze_end"]) / TICKRATE)
        else:
            round_info["phase"] = "over"
            round_info["win_team"] = r["winner"]
            countdown = ("over", (r["next_start"] - tick) / TICKRATE)
        if b["planted"]:
            round_info["bomb"] = "exploded" if b["exploded"] else "defused" if b["defused"] else "planted"

        if tick >= r["end"] and round_index == len(self.rounds) - 1:
            map_phase = "gameover"
        elif tick >= r["end"] and r.get("halftime"):
            map_phase = "intermission"
        else:
            map_phase = "live"

        def team(side):
            key = next((k for k, s in self.side_of.items() if s == side), None)
            timeouts = rule("ct_timeouts" if side == "CT" else "terrorist_timeouts")
            return {"score": self.wins[key], "consecutive_round_losses": self.losses[key],
                    "timeouts_remaining": int(timeouts), "matches_won_this_series": 0, "name": key}

        if self.observed not in alive:
            last = self.positions.get(self.observed)
            candidates = sorted(alive, key=lambda s: math.dist(self.positions[s][:2], last[:2]) if last else 0)
            if candidates:
                self.observed = candidates[0]
            elif self.observed not in allplayers:
                self.observed = next(iter(allplayers))

        return {
            "provider": {"name": "Counter-Strike: Global Offensive", "appid": 730,
                         "version": int(header.get("patch_version", 0) or 0),
                         "steamid": "76561197960265728", "timestamp": 0},
            "map": {"mode": "competitive", "name": header["map_name"], "phase": map_phase,
                    "round": self.rounds_done, "team_ct": team("CT"), "team_t": team("T"),
                    "num_matches_to_win_series": 0, "current_spectators": 0, "souvenirs_total": 0,
                    "round_wins": dict(self.round_wins)},
            "round": round_info,
            "player": {"steamid": self.observed, **allplayers[self.observed], "activity": "playing"},
            "allplayers": allplayers,
            "phase_countdowns": {"phase": countdown[0], "phase_ends_in": f"{max(0.0, countdown[1]):.1f}"},
            "grenades": gsi_grenades,
            "bomb": bomb,
        }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("demo")
    ap.add_argument("out")
    ap.add_argument("--rounds", help="e.g. 4,6,13-14 (default: all)")
    ap.add_argument("--step", type=int, default=4, help="demo ticks per GSI frame (4 = 16 Hz)")
    args = ap.parse_args()

    parser = DemoParser(args.demo)
    header = parser.parse_header()
    events = load_events(parser)
    rounds = build_rounds(events)
    wanted = parse_round_list(args.rounds, len(rounds))

    sides = parser.parse_ticks(["team_num", "team_clan_name"], ticks=[r["freeze_end"] for r in rounds])
    sides = sides[sides["team_num"].isin([2, 3])]
    first = sides[sides["tick"] == rounds[0]["freeze_end"]]
    team_names = {}
    for row in first.itertuples():
        team_names[sid(row.steamid)] = row.team_clan_name or ("Team A" if row.team_num == 3 else "Team B")
    ct_first = sorted(first[first["team_num"] == 3].itertuples(), key=lambda r: r.name.lower())
    t_first = sorted(first[first["team_num"] == 2].itertuples(), key=lambda r: r.name.lower())
    slots = {sid(row.steamid): i for i, row in enumerate(ct_first + t_first)}
    side_by_round = {}
    for r in rounds:
        at = sides[sides["tick"] == r["freeze_end"]]
        side_by_round[r["num"]] = {team_names.get(sid(x.steamid)): x.team_num for x in at.itertuples()}
    for cur, nxt in zip(rounds, rounds[1:]):
        cur["halftime"] = side_by_round[cur["num"]] != side_by_round[nxt["num"]]

    sample_ticks = []
    for r in rounds:
        if r["num"] in wanted:
            sample_ticks.extend(range(r["start"], r["next_start"], args.step))
    sample_set = set(sample_ticks)

    detonations = defaultdict(list)
    for row in events["smokegrenade_detonate"].itertuples():
        detonations[row.entityid].append(row.tick)
    grenades = grenade_instances(parser, sample_set, detonations)
    infernos = inferno_list(events)

    ticks = parser.parse_ticks(PLAYER_PROPS + RULES_PROPS + list(RULES_RAW), ticks=sample_ticks)
    ticks = ticks.rename(columns=RULES_RAW)
    ticks = ticks[ticks["team_num"].isin([2, 3]) & ticks["steamid"].map(sid).isin(slots.keys())]
    by_tick = {t: list(g.itertuples()) for t, g in ticks.groupby("tick")}

    timeline = []
    for name in EVENTS:
        df = events[name]
        if name in ("round_freeze_end", "smokegrenade_detonate", "inferno_startburn", "inferno_expire") or df.empty:
            continue
        timeline.extend((int(row.tick), EVENTS.index(name), name, row) for row in df.itertuples())
    timeline.sort(key=lambda e: (e[0], e[1]))

    match = Match(rounds, slots, team_names, side_by_round)
    for row in first.itertuples():
        match.side_of[team_names[sid(row.steamid)]] = "CT" if row.team_num == 3 else "T"
        match.teams[sid(row.steamid)] = "CT" if row.team_num == 3 else "T"

    kills_meta = []
    round_of = lambda t: next((r["num"] for r in rounds if r["start"] <= t < r["next_start"]), None)
    for row in events["player_death"].itertuples():
        kills_meta.append({"tick": int(row.tick), "round": round_of(row.tick), "killer": row.attacker_name
                           if isinstance(row.attacker_name, str) else None, "victim": row.user_name,
                           "assister": row.assister_name if isinstance(row.assister_name, str) else None,
                           "weapon": row.weapon, "headshot": bool(row.headshot)})

    written, pointer = 0, 0
    with open(args.out, "w") as out:
        for tick in sample_ticks:
            while pointer < len(timeline) and timeline[pointer][0] <= tick:
                t, _, name, row = timeline[pointer]
                match.on_event(name, row, t)
                pointer += 1
            rows = by_tick.get(tick)
            if not rows or len(rows) < 2:
                continue
            index = next(i for i, r in enumerate(rounds) if r["start"] <= tick < r["next_start"])
            gsi = match.frame(tick, index, rows, grenades.get(tick, ()), infernos, header)
            out.write(json.dumps({"tick": tick, "round": rounds[index]["num"], "gsi": gsi}, separators=(",", ":")))
            out.write("\n")
            written += 1

    meta = {
        "demo": args.demo, "map": header["map_name"], "tickrate": TICKRATE, "step": args.step,
        "teams": sorted(set(team_names.values())), "rounds": rounds, "kills": kills_meta,
        "plants": [{"tick": int(r.tick), "player": r.user_name} for r in events["bomb_planted"].itertuples()],
        "defuses": match.defuse_starts,
        "smokes": [{"tick": int(r.tick)} for r in events["smokegrenade_detonate"].itertuples()],
    }
    with open(args.out + ".meta.json", "w") as f:
        json.dump(meta, f, indent=1, default=str)
    print(f"{written} frames, rounds {sorted(wanted)}, {header['map_name']}, teams {meta['teams']}")


if __name__ == "__main__":
    main()
