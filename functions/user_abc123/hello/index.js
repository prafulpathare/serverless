export const handler = async (event, context) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Hello from Client A!",
      input: event,
      requestId: context.awsRequestId
    })
  };
};