import { cloudstate, useCloud, useLocal, type CloudState } from "freestyle-sh";
import { EmojiNoun, EmojiNounRes } from "./emoji-noun";
import { getFirstEmoji } from "../helpers/emoji-strings";

import Anthropic from "@anthropic-ai/sdk";
import Prompts from "../prompts/prompts";
import { getFirstText } from "../helpers/anthropic-msg";

interface NounChoices {
	obvious_choice: string;
	exciting_choice: string;
}

@cloudstate
export class GlobalCacheCS {
	static id = "global-cache" as const;

	combosMap: Map<string, EmojiNoun> = new Map();
	set(comboKey: string, noun: EmojiNoun) {
		this.combosMap.set(comboKey, noun);
	}
	get(comboKey: string): EmojiNoun {
		return this.combosMap.get(comboKey)!;
	}
	has(comboKey: string): boolean {
		return this.combosMap.has(comboKey);
	}
}

@cloudstate
export class RoomManagerCS {
	static id = "room-manager" as const;

	roomsMap: Map<string, RoomCS> = new Map();
	async roomExists(roomId: string): Promise<boolean> {
		console.log('|cloud> Checking if room exists:', roomId)
		console.log('|cloud> roomManager.roomsMap:', this.roomsMap)
		return this.roomsMap.has(roomId);
	}
	getRoomInfo(roomId: string): RoomInfo {
		const room = this.roomsMap.get(roomId);
		if (!room) throw new Error(`No room with id ${roomId} found.`)
		return {
			id: room.id,
			name: room.name,
		}
	}
	async createRoom(): Promise<string> {
		const room = new RoomCS();
		const roomId = room.getId();
		this.roomsMap.set(roomId, room);
		console.log('|cloud> Room created:', roomId);
		console.log('|cloud> roomManager.roomsMap:', this.roomsMap)
		return roomId;
	}
}

export interface RoomInfo {
	id: string;
	name: string;
}

@cloudstate
export class RoomCS {
	id = crypto.randomUUID();
	getId(): string {
		return this.id;
	}

	name = '';
	setName(name: string) {
		this.name = name;
	}
	getName() {
		return this.name;
	}
	
	setAnthropicApiKey(apiKey: string) {
		process.env.ANTHROPIC_API_KEY = apiKey;
	}
	nouns: EmojiNoun[] = [
		{text: 'Water', emoji: '💧'},
		{text: 'Fire', emoji: '🔥'},
		{text: 'Wind', emoji: '🌬️'},
		{text: 'Earth', emoji: '🌍'},
	];
	getNouns(): EmojiNoun[] {
		return this.nouns;
	}
	async craftNoun(a: EmojiNoun, b: EmojiNoun): Promise<EmojiNounRes> {
		const roomNouns: EmojiNoun[] = this.getNouns();
		const cache = useLocal(GlobalCacheCS);

		const comboKey = EmojiNoun.createKey(a, b);
		if (await cache.has(comboKey)) {
			console.log('|cloud> Combo is already in global cache:', comboKey)
			
			// Noun from combination is already in global cache
			const globalNoun = await cache.get(comboKey);
			return {
				...globalNoun,
				isNewToRoom: !roomNouns.some(noun => noun.text === globalNoun.text),
			};
		}

		// Generate noun choices and choose one randomly
		const nounChoices = await RoomCS._generateNounChoices(comboKey);
		const chosenNoun: string = Math.random() < 0.9 ? nounChoices.obvious_choice : nounChoices.exciting_choice;

		let comboResult: EmojiNoun;
		const isNewToRoom: boolean = !roomNouns.some(noun => noun.text === chosenNoun);
		if (isNewToRoom) {
			// Generate best emoji for noun
			const bestEmoji = await RoomCS._generateBestEmoji(chosenNoun);
			comboResult = {text: chosenNoun, emoji: getFirstEmoji(bestEmoji)};
			roomNouns.push(comboResult);
		} else {
			// Noun already exists in room; don't regenerate emoji
			comboResult = this.nouns.find(noun => noun.text === chosenNoun)!;
		}

		// Add noun to global cache
		cache.set(comboKey, comboResult);
		
		// Return the response payload
		return {...comboResult, isNewToRoom: isNewToRoom};
	}

	// LLM prompting
	static _generateNounChoices = async (comboKey: string): Promise<NounChoices> => {
		const nounChoicesMsg = await new Anthropic().messages.create({
			model: 'claude-3-haiku-20240307',
			max_tokens: 200,
			temperature: 0.5,
			system: Prompts.GENERATE_NEW_NOUN,
			messages: [{'role': 'user','content': [{'type': 'text','text': comboKey}]}],
		});
		return JSON.parse(getFirstText(nounChoicesMsg));
	}
	static _generateBestEmoji = async (noun: string): Promise<string> => {
		const selectedEmojiMsg = await new Anthropic().messages.create({
			model: 'claude-3-haiku-20240307',
			max_tokens: 200,
			temperature: 0,
			system: Prompts.PICK_BEST_EMOJI,
			messages: [{'role': 'user','content': [{'type': 'text','text': noun}]}],
		});
		return JSON.parse(getFirstText(selectedEmojiMsg))["best_choice"];
	}
}
