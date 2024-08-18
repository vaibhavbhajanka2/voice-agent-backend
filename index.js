const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const textToSpeech = require('@google-cloud/text-to-speech');
const speech = require('@google-cloud/speech');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');
const OpenAI = require('openai');
const osu = require('node-os-utils');
const oneLinerJoke = require('one-liner-joke');

require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use(cors({
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
}));

const io = new Server(server, {
    cors: {
        origin: 'http://localhost:3000',
        methods: ['GET', 'POST'],
    }
});

const textToSpeechClient = new textToSpeech.TextToSpeechClient({
    keyFileName: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

const speechClient = new speech.SpeechClient({
    keyFileName: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const getCurrentTime = () => {
    const now = new Date();
    return now.toLocaleTimeString();
};

const getCurrentDate = () => {
    const now = new Date();
    return now.toLocaleDateString();
};

const getSystemStats = async () => {
    const cpuUsage = await osu.cpu.usage();
    return `CPU Usage is at ${cpuUsage}%.`;
};

const getJoke = () => {
    const joke = oneLinerJoke.getRandomJoke();
    return joke.body;
};

const handleQuery = async (transcription, socket) => {
    let responseText;

    if (transcription.toLowerCase().includes('time')) {
        responseText = `The current time is ${getCurrentTime()}.`;
    } else if (transcription.toLowerCase().includes('date')) {
        responseText = `The current date is ${getCurrentDate()}.`;
    } else if (transcription.toLowerCase().includes('cpu')) {
        responseText = await getSystemStats();
    } else if (transcription.toLowerCase().includes('joke')) {
        responseText = getJoke();
    } else {
        responseText = await generateGPTResponse(transcription, socket);
    }

    // Emit the response back to the client
    socket.emit('gptResponse', responseText);

    // Perform TTS and send back the audio if needed
    try {
        const ttsRequest = {
            input: { text: responseText },
            voice: { languageCode: 'en-US', ssmlGender: 'MALE' },
            audioConfig: { audioEncoding: 'MP3' },
        };

        const [ttsResponse] = await textToSpeechClient.synthesizeSpeech(ttsRequest);
        const outputPath = path.join(__dirname, 'response.mp3');
        fs.writeFileSync(outputPath, ttsResponse.audioContent, 'binary');
        console.log('Audio content written to file: response.mp3');

        fs.readFile(outputPath, (err, data) => {
            if (err) {
                console.error('Error reading TTS file:', err);
                socket.emit('error', 'Error reading TTS file');
                return;
            }
            socket.emit('gpt', data);
        });
    } catch (error) {
        console.error('Error generating TTS for response:', error.message);
        socket.emit('error', 'Error generating TTS for response');
    }

    return responseText;
};



const generateGPTResponse = async (transcription, socket) => {
    const gptResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",  // Ensure this model exists or use a correct one like "gpt-3.5-turbo" or "gpt-4"
        messages: [
            {role: "system", content: "You are a friendly and conversational AI assistant. Keep your responses concise and natural." },
            {role: "user", content: transcription},
        ],
    });

    const gptAnswer = gptResponse.choices[0].message.content.trim();
    socket.emit('gptResponse', gptAnswer);
    return gptAnswer;
}

io.on('connection', (socket) => {
    console.log('A user connected');

    // Handle Text-to-Speech request (greeting)
    socket.on('requestGreeting', async (userName) => {
        // Generate the personalized greeting message based on the current time
        let greetingMessage = `Welcome Back ${userName}! `;
        const hour = new Date().getHours();

        if (6 <= hour && hour < 12) {
            greetingMessage += "Good Morning Sir! ";
        } else if (12 <= hour && hour < 18) {
            greetingMessage += "Good Afternoon Sir! ";
        } else if (18 <= hour && hour < 24) {
            greetingMessage += "Good Evening Sir! ";
        } else {
            greetingMessage += "Good Night Sir! ";
        }

        greetingMessage += "Jarvis at your service. Please tell me how can I help you today?";

        try {
            const request = {
                input: { text: greetingMessage },
                voice: { languageCode: 'en-US', ssmlGender: 'MALE' },
                audioConfig: { audioEncoding: 'MP3' },
            };

            // Perform the Text-to-Speech request
            const [response] = await textToSpeechClient.synthesizeSpeech(request);

            // Define the output file path
            const outputPath = path.join(__dirname, 'greeting.mp3');

            // Write the binary audio content to a local file
            fs.writeFileSync(outputPath, response.audioContent, 'binary');
            console.log('Audio content written to file: greeting.mp3');

            // Read the file and emit the audio data as a buffer
            fs.readFile(outputPath, (err, data) => {
                if (err) {
                    console.error(`Error reading file: ${err}`);
                    socket.emit('error', 'Error reading greeting file');
                    return;
                }
                socket.emit('greeting', data);
            });
        } catch (error) {
            console.error(`Error generating greeting: ${error.message}`);
            socket.emit('error', 'Error generating greeting');
        }
    });

    socket.on('audioStream', async (audioBuffer) => {
        try {
            console.log("Received audio buffer size:", audioBuffer.length);

            // Convert audioBuffer to a readable stream
            const bufferStream = new stream.PassThrough();
            bufferStream.end(Buffer.from(audioBuffer));

            // Convert webm to wav using ffmpeg
            let audioChunks = [];
            ffmpeg(bufferStream)
                .inputFormat('webm')
                .audioFrequency(48000)  // Match the actual sample rate
                .toFormat('wav')
                .on('error', (err) => {
                    console.error('Error converting audio:', err);
                    socket.emit('error', 'Error converting audio');
                })
                .on('end', () => {
                    console.log('Audio conversion complete');
                })
                .pipe(new stream.PassThrough())
                .on('data', (chunk) => {
                    audioChunks.push(chunk);
                })
                .on('end', async () => {
                    const audioBuffer = Buffer.concat(audioChunks);
                    console.log("Converted audio buffer size:", audioBuffer.length);

                    const request = {
                        audio: {
                            content: audioBuffer.toString('base64'),
                        },
                        config: {
                            encoding: 'LINEAR16',
                            sampleRateHertz: 48000,  // Ensure this matches the audio file
                            languageCode: 'en-US',
                            enableAutomaticPunctuation: true,  // Optional: enable punctuation
                        },
                    };

                    try {
                        const [response] = await speechClient.recognize(request);
                        console.log('Speech-to-Text response:', JSON.stringify(response, null, 2));

                        const transcription = response.results
                            .map(result => result.alternatives[0].transcript)
                            .join('\n');
                        console.log(`Transcription: ${transcription}`);

                        // Send the transcribed text back to the client
                        socket.emit('transcription', transcription);

                        if (transcription.length > 0){
                            const answer = await handleQuery(transcription, socket);
                        }

                    } catch (error) {
                        console.error(`Error during speech recognition or fetching data from Open AI: ${error.message}`);
                        socket.emit('error', 'Error during speech recognition or fetching data from Open AI');
                    }
                });
        } catch (error) {
            console.error(`Error during audio processing: ${error.message}`);
            socket.emit('error', 'Error during audio processing');
        }
    });


    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

server.listen(5002, () => {
    console.log('Server is running on http://localhost:5002');
});
