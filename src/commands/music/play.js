'use babel';
'use strict';

import { Command, CommandFormatError } from 'discord-graf';
import yt from 'ytdl-core';
import Song from '../../song';

export default class PlaySongCommand extends Command {
	constructor(bot) {
		super(bot, {
			name: 'play',
			module: 'music',
			memberName: 'play',
			description: 'Adds a song to the queue.',
			usage: 'play <YouTube URL>',
			guildOnly: true
		});

		this.queue = new Map();
	}

	run(message, args) {
		return new Promise(resolve => {
			if(!args[0]) throw new CommandFormatError(this, message.guild);
			const url = args[0].replace(/<(.+)>/g, '$1');
			let queue = this.queue.get(message.guild.id);

			// Get the voice channel the user is in
			let voiceChannel;
			if(!queue) {
				voiceChannel = message.member.voiceChannel;
				if(!voiceChannel || voiceChannel.type !== 'voice') {
					resolve('You aren\'t in a voice channel, ya dingus.');
					return;
				}
			} else if(!queue.voiceChannel.members.has(message.author.id)) {
				resolve('You\'re not in the voice channel. You better not be trying to mess with their mojo, man.');
				return;
			}

			yt.getInfo(url, (err, info) => {
				if(err) {
					resolve('Couldn\'t fetch the video information from YouTube. You may have supplied an invalid URL.');
					return;
				}

				if(!queue) {
					// Create the guild's queue
					queue = {
						textChannel: message.channel,
						voiceChannel: voiceChannel,
						connection: null,
						songs: [],
						volume: 6
					};
					this.queue.set(message.guild.id, queue);

					// Try to add the song to the queue
					const result = this.addSong(message, info, url);

					if(result.startsWith(':thumbsup:')) {
						// Join the voice channel and start playing
						voiceChannel.join().then(connection => {
							queue.connection = connection;
							this.play(message.guild, queue.songs[0]);
							resolve({ editable: false });
						}).catch(err2 => {
							this.bot.logger.error('Error occurred when joining voice channel.', err2);
							this.queue.delete(message.guild.id);
							resolve('Unable to join your voice channel.');
						});
					} else {
						resolve(result);
					}
				} else {
					// Just add the song
					resolve({ reply: this.addSong(message, info, url), editable: false });
				}
			});
		});
	}

	addSong(message, info, url) {
		const queue = this.queue.get(message.guild.id);

		// Verify some stuff
		if(!this.bot.permissions.isAdmin(message.guild, message.author)) {
			if(info.length_seconds > 60 * 15) return ':thumbsdown: No songs longer than 15 minutes!';
			if(queue.songs.some(song => song.id === info.video_id)) {
				return `:thumbsdown: **${info.title}** is already queued.`;
			}
			if(queue.songs.reduce((prev, song) => prev + song.member.id === message.author.id, 0) >= 5) {
				return ':thumbsdown: You already have 5 songs in the queue. Don\'t hog all the airtime!';
			}
		}

		// Add the song to the queue
		this.bot.logger.debug('Adding song to queue.', { song: info.video_id, guild: message.guild.id });
		const song = new Song(info, url, message.member);
		queue.songs.push(song);
		return `:thumbsup: Queued up **${song.name}** (${song.lengthString}).`;
	}

	play(guild, song) {
		const queue = this.queue.get(guild.id);

		// Kill the voteskip if active
		const vote = this.votes.get(guild.id);
		if(vote) {
			clearTimeout(vote);
			this.votes.delete(guild.id);
		}

		// See if we've finished the queue
		if(!song) {
			queue.textChannel.sendMessage('We\'ve run out of songs! Better queue up some more tunes.');
			queue.voiceChannel.leave();
			this.queue.delete(guild.id);
			return;
		}

		// Play the song
		queue.textChannel.sendMessage(
			`:musical_note: Playing **${song.name}** (${song.lengthString}), queued by ${song.username}.`
		);
		const dispatcher = queue.connection.playStream(
			yt(song.url, { audioonly: true }),
			{ passes: this.bot.config.values.passes }
		);
		dispatcher.on('end', () => {
			queue.songs.shift();
			this.play(guild, queue.songs[0]);
		}).on('error', (err) => {
			this.bot.logger.error('Error occurred in stream dispatcher:', err);
			queue.textChannel.sendMessage(`An error occurred while playing the song: \`${err}\``);
			queue.songs.shift();
			this.play(guild, queue.songs[0]);
		}).setVolumeLogarithmic(queue.volume / 5);
		song.dispatcher = dispatcher;
	}

	get votes() {
		if(!this._votes) this._votes = this.bot.registry.findCommands('music:skip')[0].votes;
		return this._votes;
	}
}
