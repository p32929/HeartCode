# probe.md

The one-time test of a new model's abilities. Changing these changes how models are judged.
Each `## name` below is one prompt. `{{placeholders}}` are filled in by HeartCode;
a `<!-- … -->` note under a heading explains the prompt and is never sent. To change one, copy
its section into ~/.heart/prompts/probe.md (every project) or .heartcode/prompts/probe.md (one project).

## capital

What is the capital of France? Answer in one word.

## count

Count from 1 to 10, separated by spaces. Reply with only the numbers.

## edit

<!-- The "edit skill" test. {{code}}: a small file. {{ask}}: the change to make. -->
Here is a file:
```
{{code}}```

{{ask}}
Reply with only a SEARCH/REPLACE block in exactly this format:
<<<<<<< SEARCH
(exact lines to find)
=======
(replacement lines)
>>>>>>> REPLACE

## exact-number

<!-- The "exact format" test. {{n}}: a number. -->
Reply with only the number {{n}}. No other words.

## hello

Say hello in one short sentence.

## image-color

What color is this image? Reply with one word.

## menu

<!-- The "menu picking" test. {{what}}: e.g. "a fruit". {{list}}: numbered options. -->
Which of these is {{what}}?
{{list}}
Reply with only the number.

## system

<!-- The system prompt of the "follows the system prompt" test; the model passes by replying BANANA. -->
Whatever the user says, reply with only the single word BANANA.

## tool-description

Look up the secret code for a name.

## tool-question

<!-- The tool-call test. {{name}}: the name to look up. -->
What is the secret code for "{{name}}"? Use the get_secret_code tool to find out.

## tool-result

The secret code is ZX-4417.
