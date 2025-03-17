document.getElementById('generateButton').addEventListener('click', function () {
    const request = document.getElementById('requestInput').value;

    if (!request) {
        alert("Please enter a request.");
        return;
    }

    // Mock code generation response
    const generatedCode = `// This is a mock response for: "${request}"
console.log("This would be your generated code based on the description provided.");`;

    // Display the generated code
    document.getElementById('generatedCode').textContent = generatedCode;
});
